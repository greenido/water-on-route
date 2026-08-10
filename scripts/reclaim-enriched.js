#!/usr/bin/env node
/**
 * Reclaim the space taken by stored enriched GPX copies.
 *
 * enriched_gpx_text is derivable from gpx_text plus water_points_json, and is
 * now rebuilt on download, so the stored copies are redundant. This clears
 * them and compacts the file.
 *
 * A row is only cleared once its enriched GPX has actually been rebuilt from
 * that row's own data in this process, so nothing is dropped that cannot be
 * produced again.
 *
 * Usage:
 *   node scripts/reclaim-enriched.js          # report only, changes nothing
 *   node scripts/reclaim-enriched.js --apply  # clear and VACUUM
 */

const fs = require('fs');
const sqlite3 = require('sqlite3');
const { buildEnrichedGpx } = require('../server/enrichedGpx');
const { DB_PATH } = require('../server/db');

const APPLY = process.argv.includes('--apply');

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      return err ? reject(err) : resolve(this);
    });
  });
}

function countWaypoints(gpxText) {
  return (gpxText.match(/<wpt[\s>]/g) || []).length;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const db = new sqlite3.Database(DB_PATH);
  const sizeBefore = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;

  const rows = await all(
    db,
    `SELECT id, filename, gpx_text, water_points_json, enriched_gpx_text,
            length(enriched_gpx_text) AS enriched_bytes
     FROM routes
     WHERE enriched_gpx_text IS NOT NULL
     ORDER BY id`
  );

  if (!rows.length) {
    console.log('Nothing to reclaim: no rows store an enriched copy.');
    db.close();
    return;
  }

  for (const row of rows) row.stored_wpts = countWaypoints(row.enriched_gpx_text);

  const regenerable = [];
  const blocked = [];
  for (const row of rows) {
    const rebuilt = buildEnrichedGpx(row.gpx_text, parseJson(row.water_points_json));
    if (!rebuilt) {
      blocked.push({ ...row, why: 'cannot be rebuilt from the stored points' });
      continue;
    }
    // Rebuilding is not enough: it has to produce the same waypoints the
    // stored file holds. Some archived copies contain every waypoint twice,
    // and some rows kept more points than were ever exported. Clearing those
    // would quietly change what the archive contains.
    const rebuiltCount = countWaypoints(rebuilt);
    if (rebuiltCount !== row.stored_wpts) {
      blocked.push({ ...row, why: `stored file has ${row.stored_wpts} waypoints, rebuild gives ${rebuiltCount}` });
      continue;
    }
    regenerable.push(row);
  }

  const reclaimable = regenerable.reduce((sum, r) => sum + (r.enriched_bytes || 0), 0);
  const stuck = blocked.reduce((sum, r) => sum + (r.enriched_bytes || 0), 0);

  console.log(`Database:        ${DB_PATH}`);
  console.log(`Current size:    ${mb(sizeBefore)}`);
  console.log(`Rows with copy:  ${rows.length}`);
  console.log(`Regenerable:     ${regenerable.length} rows, ${mb(reclaimable)}`);
  if (blocked.length) {
    console.log(`Kept as-is:      ${blocked.length} rows, ${mb(stuck)}`);
    for (const row of blocked) {
      console.log(`  - #${row.id} ${row.filename || '(no name)'}: ${row.why}`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to clear the regenerable copies and VACUUM.');
    db.close();
    return;
  }

  await run(db, 'BEGIN');
  for (const row of regenerable) {
    // Mark as verified in the same statement that drops the copy, so a row
    // can never end up cleared without the download path being allowed to
    // rebuild it.
    await run(db, 'UPDATE routes SET enriched_gpx_text = NULL, enriched_regenerable = 1 WHERE id = ?', [row.id]);
  }
  await run(db, 'COMMIT');
  // VACUUM cannot run inside a transaction and is what actually shrinks the file.
  await run(db, 'VACUUM');

  const sizeAfter = fs.statSync(DB_PATH).size;
  console.log(`\nCleared ${regenerable.length} rows.`);
  console.log(`Size:            ${mb(sizeBefore)} -> ${mb(sizeAfter)} (${mb(sizeBefore - sizeAfter)} reclaimed)`);
  db.close();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exitCode = 1;
});
