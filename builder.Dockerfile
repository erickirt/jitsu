# Docker image for building and testing the application in CI
# This image includes all build dependencies to speed up CI workflows:
# - Node.js 22 (matches .node-version)
# - pnpm 9 (our package manager)
# - Playwright with browser binaries (for running browser tests)
#
# This image is automatically built and published to GHCR when this file changes.
# Manual build command:
#   docker buildx build --platform linux/amd64,linux/arm64 -f builder.Dockerfile --push -t ghcr.io/jitsucom/jitsu-builder:latest .

FROM node:22-bookworm
RUN apt-get update
# Telnet is useful for debugging, and we need curl for Node, jq for JSON parsing
RUN apt-get install git curl telnet python3 ca-certificates gnupg g++ make jq -y

RUN npm -g install pnpm@9

# Copy only the files needed for dependency fetching and Playwright version extraction
# pnpm fetch only needs the lockfile and workspace config, not all package.json files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY libs/jitsu-js/package.json ./libs/jitsu-js/package.json

# Extract Playwright version dynamically from libs/jitsu-js/package.json
# This ensures the builder image always matches the project's Playwright version
RUN PLAYWRIGHT_VERSION=$(jq -r '.devDependencies["@playwright/test"]' ./libs/jitsu-js/package.json) && \
    echo "Installing Playwright version: ${PLAYWRIGHT_VERSION}" && \
    npm install --global playwright@${PLAYWRIGHT_VERSION} && \
    playwright install --with-deps

# Pre-fetch all dependencies into pnpm cache to speed up CI builds
# pnpm fetch reads pnpm-lock.yaml and downloads all packages to the store
# When CI runs pnpm install, packages are already cached for instant installation
RUN pnpm fetch

# Clean up copied files to reduce image size
# The pnpm cache remains populated at ~/.local/share/pnpm/store
RUN rm -rf /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /libs
