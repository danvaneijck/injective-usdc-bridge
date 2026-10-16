# Build from the repo root:  docker build -f service/Dockerfile -t injective-usdc-bridge-service .
FROM node:24-bookworm-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches this Node.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/bridge/package.json packages/bridge/
COPY service/package.json service/
COPY apps/site/package.json apps/site/
RUN npm ci --no-audit --no-fund
COPY packages/bridge packages/bridge
COPY service service
COPY apps/site apps/site
# The site is served by this same service (SITE_DIR), so it calls its own origin.
RUN npm run build -w injective-usdc-bridge \
    && npm run build -w injective-usdc-bridge-site \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/bridge.sqlite PORT=8787 SITE_DIR=/app/apps/site/dist
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/service
CMD ["npx", "tsx", "src/main.ts"]
