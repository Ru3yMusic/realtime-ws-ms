# realtime-ws-ms

WebSocket gateway for RUBY MUSIC real-time features: station comments, user presence, and notification delivery.

**Port:** `3001` | **Framework:** NestJS 10 + Socket.IO 4 | **Contract:** `asyncapi.yml`

---

## Responsibilities

- Accept WebSocket connections from iOS clients (authenticated via `X-User-Id` header)
- Broadcast station comments optimistically before Kafka persistence
- Manage user presence in Redis (TTL 300 s)
- Publish Avro events to Kafka (`realtime.comment.created`, `realtime.comment.liked`)
- Consume `realtime.notification.push` from Kafka and push to the correct WebSocket client
- Expose REST endpoints for comment likes/unlikes and presence queries

---

## Architecture

```
iOS Client
  │  Socket.IO handshake (X-User-Id, X-Display-Name, X-Profile-Photo-Url)
  ▼
StationGateway          ─── optimistic broadcast ──▶  station:{stationId} room
  │  send_comment
  └── KafkaProducerService ──▶  realtime.comment.created  (Avro)
  │  like/unlike (REST)
  └── KafkaProducerService ──▶  realtime.comment.liked    (Avro)

KafkaConsumerService ◀── realtime.notification.push (Avro) ── realtime-api-ms
  └── SocketStateService ──▶  user:{userId} room  (notification event)
```

---

## WebSocket Events (AsyncAPI contract: `asyncapi.yml`)

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join_station` | `{ stationId, songId }` | Join a station room; sets Redis presence |
| `leave_station` | — | Leave current station; clears Redis presence |
| `send_comment` | `{ commentId, songId, stationId, content, mentions[] }` | Publish a comment (optimistic broadcast + Kafka) |
| `ping_presence` | — | Heartbeat to refresh Redis TTL (send every 60 s) |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `new_comment` | `WsCommentPayload` | Broadcast to all users in `station:{stationId}` |
| `notification` | `WsNotificationPayload` | Pushed to `user:{userId}` private room |
| `listener_count` | `{ stationId, count }` | Broadcast to station when listener count changes |
| `pong_presence` | `{ ok: true }` | Response to `ping_presence` |
| `joined_station` | `{ stationId, listenerCount }` | Acknowledgement after joining |

### Authentication
Pass a JWT access token in Socket.IO handshake auth (`auth.token`).
The service verifies the token with the shared RSA public key and extracts `sub` as `userId`.

Connections without a valid token are rejected.

Optional (premium UX): client may emit `auth_refresh` with a renewed access token to refresh
socket identity without forcing a full reconnect.

```
// iOS Socket.IO connection example
const socket = io("wss://<gateway-domain>", {
  auth: {
    token: "Bearer <access-token>"
  }
});
```

---

## REST Endpoints

All routes prefixed with `/api` (e.g. `GET /api/presence/me`).

### Presence

| Method | Path | Headers | Description |
|---|---|---|---|
| `GET` | `/api/presence/me` | `X-User-Id` | Get own presence data |
| `GET` | `/api/presence/users/:userId` | — | Get a specific user's presence |
| `GET` | `/api/presence/stations/:stationId/listeners` | — | Get active listener count + IDs |

### Comments (mutations)

| Method | Path | Headers | Body | Description |
|---|---|---|---|---|
| `POST` | `/api/comments/:id/like` | `X-User-Id`, `X-Display-Name`, `X-Profile-Photo-Url` | `{ commentAuthorId, songId, stationId }` | Like a comment — fires Kafka event |
| `DELETE` | `/api/comments/:id/like` | `X-User-Id`, `X-Display-Name` | `{ commentAuthorId, songId, stationId }` | Unlike a comment — fires compensating Kafka event |

Both like/unlike return `HTTP 202 Accepted` — persistence is async in `realtime-api-ms`.

---

## Kafka Topics

| Topic | Role | Format | Key |
|---|---|---|---|
| `realtime.comment.created` | **Produce** | Avro | `station_id` |
| `realtime.comment.liked` | **Produce** | Avro | `comment_id` |
| `realtime.notification.push` | **Consume** | Avro | — |

Consumer group: `realtime-ws-ms`

### Unlike convention
Unlike events reuse `realtime.comment.liked` with `liker_username` prefixed as `UNLIKE:<username>`. The api-ms handler detects this prefix and calls `decrementLikes` instead.

---

## Avro Schemas (`avro/schemas/`)

| File | Event |
|---|---|
| `realtime.comment.created.avsc` | `CommentCreatedEvent` |
| `realtime.comment.liked.avsc` | `CommentLikedEvent` |
| `realtime.notification.push.avsc` | `NotificationPushEvent` |

### Schema Registry modes
- **Dev** (`SCHEMA_REGISTRY_URL` unset): local `.avsc` files, raw Avro binary (no magic byte)
- **Prod** (`SCHEMA_REGISTRY_URL` set): Confluent wire format — `0x00` + 4-byte schema ID + Avro payload

---

## Redis Keys

| Key pattern | Type | TTL | Managed by |
|---|---|---|---|
| `presence:{userId}` | Hash (`station_id`, `song_id`, `last_active`) | 300 s | `RedisService` |
| `station:{stationId}:listeners` | Sorted set (score = epoch ms) | — (pruned by score) | `RedisService` |
| `badge:notifications:{userId}` | String (integer counter) | none | `RedisService` |
| `badge:friends:{userId}` | String (integer counter) | none | `RedisService` |

Presence expires automatically after 5 minutes of inactivity (no explicit logout needed). Stale members in the station listener sorted set are pruned on each `addStationListener` call.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket port |
| `REDIS_HOST` | _(required)_ | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis AUTH password |
| `KAFKA_BROKER` | _(required)_ | Kafka broker address |
| `KAFKA_GROUP_ID` | `realtime-ws-ms` | Kafka consumer group |
| `SCHEMA_REGISTRY_URL` | _(empty)_ | Confluent Schema Registry URL — empty = dev mode |

In Docker all values are injected via `docker-compose.yml` from the root `.env`. The `.env.example` file is for local non-Docker development only.

---

## Build & Run

```bash
# Install dependencies
npm install

# Generate AsyncAPI TypeScript models (output: src/generated/models/)
npm run generate:asyncapi

# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm start

# Generate AsyncAPI HTML documentation (output: docs/asyncapi/)
npm run generate:docs
```

### Run with Docker (from repo root)
```bash
docker compose up realtime-ws-ms
```

---

## Module Structure

```
src/
├── main.ts                      ← Bootstrap; /health endpoint; global prefix /api
├── app.module.ts
├── config/
│   └── configuration.ts         ← Typed config from process.env
├── gateway/
│   ├── station.gateway.ts       ← All WebSocket events (AsyncAPI channels)
│   └── dto/                     ← join-station, send-comment, like-comment DTOs
├── kafka/
│   ├── kafka.producer.ts        ← publishCommentCreated / publishCommentLiked
│   └── kafka.consumer.ts        ← Consumes notification.push → SocketStateService
├── schema-registry/
│   └── schema-registry.service.ts  ← Avro encode/decode (dev + Confluent prod)
├── redis/
│   └── redis.service.ts         ← presence, station listeners, badge counters
├── socket/
│   └── socket-state.service.ts  ← userId → Set<Socket> in-memory map
├── presence/
│   ├── presence.service.ts      ← joinStation / leaveStation / refreshHeartbeat
│   └── presence.controller.ts   ← REST: GET /presence/*
├── comments/
│   └── comments.controller.ts   ← REST: POST/DELETE /comments/:id/like
└── common/types/
    └── avro-events.types.ts     ← TypeScript interfaces for all Kafka + WS payloads
```
