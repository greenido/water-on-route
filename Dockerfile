# syntax=docker/dockerfile:1.9

# Adjust NODE_VERSION as desired. undici requires Node >= 22.19.0.
ARG NODE_VERSION=22.22.0
# Pinned to trixie: the sqlite3 prebuilt binary needs glibc >= 2.38, which bookworm (2.36) lacks.
FROM node:${NODE_VERSION}-trixie-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY . .


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Keep the application and mounted data path writable without root privileges.
RUN mkdir -p /app/data /data && chown -R node:node /app /data

# Start the server by default, this can be overwritten at runtime
USER node
EXPOSE 3000
CMD [ "npm", "run", "start" ]
