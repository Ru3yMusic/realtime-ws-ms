# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .

# Generate AsyncAPI models then compile TypeScript
RUN npm run generate:asyncapi && npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

RUN addgroup -S rubymusic && adduser -S rubymusic -G rubymusic

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist
COPY --from=build /app/avro ./avro

RUN chown -R rubymusic:rubymusic /app

USER rubymusic

# WebSocket + HTTP
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3001/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["node", "dist/main"]
