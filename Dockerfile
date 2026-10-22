# FastMemo Server: one small image, for amd64 (PC, VPS) and arm64 (Raspberry Pi 3/4/5 with a 64-bit OS, Apple silicon).
# Node runs the TypeScript sources as they are: there's no build step.
# Published as ghcr.io/ontech7/fastmemo-server by .github/workflows/release.yml (on a v* tag).
FROM node:24.22.1-alpine3.24

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# The database lives in /data: a volume, so it outlives the container (updates, restarts).
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/v1/health" || exit 1

# Node handles SIGTERM itself: `docker stop` lets it finish the requests in flight and close the database cleanly.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
