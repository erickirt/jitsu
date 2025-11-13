# Docker image for building and testing the application in CI
# This image includes all build dependencies to speed up CI workflows:
# - Node.js 22 (matches .node-version)
# - pnpm 10 (our package manager)
# - Playwright with browser binaries (for running browser tests)
#
# This image is automatically built and published to GHCR when this file changes.
# Manual build command:
#   docker buildx build --platform linux/amd64,linux/arm64 -f builder.Dockerfile --push -t ghcr.io/jitsucom/jitsu-builder:latest .

FROM debian:bookworm-slim

# Install Node.js 22 manually from NodeSource
RUN apt-get update && \
    apt-get install -y ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs && \
    apt-get install git curl telnet python3 g++ make jq -y && \
    rm -rf /var/lib/apt/lists/* && \
    npm -g install pnpm@10 && \
    npm cache clean --force

# Set up pnpm global bin directory
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN mkdir -p ${PNPM_HOME}

# Copy only the files needed for dependency fetching and Playwright version extraction
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY libs/jitsu-js/package.json ./libs/jitsu-js/package.json

# Install minimal Chromium dependencies manually
RUN apt-get update && \
    apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Extract Playwright version before cleanup
RUN PLAYWRIGHT_VERSION=$(jq -r '.devDependencies["@playwright/test"]' ./libs/jitsu-js/package.json) && \
    echo "${PLAYWRIGHT_VERSION}" > /tmp/playwright-version.txt && \
    echo "Playwright version to install: ${PLAYWRIGHT_VERSION}"

# Fetch pnpm dependencies (only populates the store, doesn't create node_modules)
RUN pnpm fetch && \
    rm -rf /package.json /pnpm-lock.yaml /pnpm-workspace.yaml /libs

# Install Playwright globally with pnpm
RUN PLAYWRIGHT_VERSION=$(cat /tmp/playwright-version.txt) && \
    echo "Installing Playwright version: ${PLAYWRIGHT_VERSION}" && \
    pnpm add --global playwright@${PLAYWRIGHT_VERSION} && \
    playwright install chromium

# Clean up any leftover node_modules
RUN rm -rf /node_modules

# Remove build tools to save ~200-300MB (not needed for CI runtime, only for builds during pnpm install)
RUN apt-get remove -y g++ gcc make python3 perl git && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
