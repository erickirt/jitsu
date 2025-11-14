# Run `docker login`, use jitsucom account
# Build & push it with
#    docker buildx build --platform linux/amd64 . -f console.Dockerfile --push -t jitsucom/console:latest

FROM node:24-bookworm AS base

WORKDIR /app
RUN apt-get update -y
RUN apt-get install nano curl cron bash netcat-traditional procps jq -y

FROM ghcr.io/jitsucom/jitsu-builder:latest AS builder

ARG CI=false

# Create app directory
WORKDIR /app

# Copy lockfile and workspace config first (cached unless these change)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Fetch dependencies into pnpm store (cached unless lockfile changes)
# ghcr.io/jitsucom/jitsu-builder:latest should contain most of the deps already
RUN pnpm fetch

# Copy source code
COPY . .
RUN rm -f .env*

# Install from cached store (fast since fetch already downloaded)
# This layer is still invalidated by source changes, but install is much faster
RUN pnpm install -r --frozen-lockfile --offline --unsafe-perm

ENV NEXTJS_STANDALONE_BUILD=1
ENV CI=${CI}
#Tubo cache is not working well ?
#RUN --mount=type=cache,id=onetag_turbo,target=/app/node_modules/.cache/turbo pnpm build
RUN pnpm build

FROM base AS console

ARG JITSU_BUILD_VERSION=dev,
ARG JITSU_BUILD_DOCKER_TAG=dev,
ARG JITSU_BUILD_COMMIT_SHA=unknown,


WORKDIR /app
COPY --from=builder /app/webapps/console/package.json /tmp/console-package.json
RUN npm -g install prisma@$(jq -r '.dependencies.prisma' /tmp/console-package.json)
COPY --from=builder /app/docker-start-console.sh ./
COPY --from=builder /app/webapps/console/prisma/schema.prisma ./
COPY --from=builder /app/webapps/console/.next/standalone ./
COPY --from=builder /app/webapps/console/.next/static ./webapps/console/.next/static
COPY --from=builder /app/webapps/console/public ./webapps/console/public

COPY --from=builder /app/console.cron /etc/cron.d/console.cron
RUN chmod 0644 /etc/cron.d/console.cron
RUN crontab /etc/cron.d/console.cron

EXPOSE 3000

HEALTHCHECK CMD curl --fail http://localhost:3000/api/healthcheck || exit 1

ENV NODE_ENV=production
ENV JITSU_VERSION_COMMIT_SHA=${JITSU_BUILD_COMMIT_SHA}
ENV JITSU_VERSION_DOCKER_TAG=${JITSU_BUILD_DOCKER_TAG}
ENV JITSU_VERSION_STRING=${JITSU_BUILD_VERSION}

ENTRYPOINT ["sh", "-c", "/app/docker-start-console.sh"]

FROM base AS rotor

ARG JITSU_BUILD_VERSION=dev,
ARG JITSU_BUILD_DOCKER_TAG=dev,
ARG JITSU_BUILD_COMMIT_SHA=unknown,


WORKDIR /app
RUN addgroup --system --gid 1001 runner
RUN adduser --system --uid 1001 runner
USER runner

EXPOSE 3401

COPY --from=builder /app/services/rotor/dist .

ENV NODE_ENV=production
ENV JITSU_VERSION_COMMIT_SHA=${JITSU_BUILD_COMMIT_SHA}
ENV JITSU_VERSION_DOCKER_TAG=${JITSU_BUILD_DOCKER_TAG}
ENV JITSU_VERSION_STRING=${JITSU_BUILD_VERSION}

CMD ["--no-node-snapshot", "--max-old-space-size=2048", "main.js"]

FROM base AS profiles

ARG JITSU_BUILD_VERSION=dev,
ARG JITSU_BUILD_DOCKER_TAG=dev,
ARG JITSU_BUILD_COMMIT_SHA=unknown,


WORKDIR /app
RUN addgroup --system --gid 1001 runner
RUN adduser --system --uid 1001 runner
USER runner

EXPOSE 3401

COPY --from=builder /app/services/profiles/dist .

ENV NODE_ENV=production
ENV JITSU_VERSION_COMMIT_SHA=${JITSU_BUILD_COMMIT_SHA}
ENV JITSU_VERSION_DOCKER_TAG=${JITSU_BUILD_DOCKER_TAG}
ENV JITSU_VERSION_STRING=${JITSU_BUILD_VERSION}

CMD ["--no-node-snapshot", "--max-old-space-size=2048", "main.js"]
