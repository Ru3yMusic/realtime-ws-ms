import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const PRESENCE_TTL_MS = 300_000; // 5 min in milliseconds (for ZADD score pruning)
const PRESENCE_TTL_S  = 300;     // 5 min in seconds (for Hash TTL)

// Recent-occupants tracking: keeps a record of users who were just in a
// station so we can distinguish a transient reload from a brand-new arrival
// to an empty station. Lives long enough to cover slow reloads and brief
// network blips, short enough that returning the next day looks like a fresh
// entry that should reset the broadcast.
const RECENT_OCCUPANT_TTL_S = 120;

export interface StationSession {
  stationId: string;
  startedAtMs: number;
  queue: string[];
  durationsSeconds: number[];
  version: number;
}

const LOCK_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis({
      host:     this.config.get<string>('redis.host'),
      port:     this.config.get<number>('redis.port'),
      password: this.config.get<string | undefined>('redis.password'),
    });

    // Observability only — ioredis keeps handling retry/backoff internally.
    // These listeners surface connection issues in logs so outages (5xx
    // health, stale presence, etc.) can be correlated without guessing.
    this.client.on('error', (err) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });
    this.client.on('reconnecting', (delay: number) => {
      this.logger.warn(`Redis client reconnecting in ${delay}ms`);
    });
    this.client.on('end', () => {
      this.logger.warn('Redis client connection closed');
    });
    this.client.on('ready', () => {
      this.logger.log('Redis client ready');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Lightweight connectivity probe used by the health endpoint. Returns true
   * if Redis answers PONG, false on any failure. Never throws.
   */
  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  // ── Presence ─────────────────────────────────────────────────────────────
  // Hash: presence:{userId} → { station_id, song_id, last_active }  TTL 300s

  async setPresence(userId: string, stationId: string, songId: string): Promise<void> {
    const key = `presence:${userId}`;
    await this.client.hset(key, {
      station_id:  stationId,
      song_id:     songId,
      last_active: new Date().toISOString(),
    });
    await this.client.expire(key, PRESENCE_TTL_S);
  }

  async getPresence(userId: string): Promise<Record<string, string> | null> {
    const data = await this.client.hgetall(`presence:${userId}`);
    return Object.keys(data).length ? data : null;
  }

  async removePresence(userId: string): Promise<void> {
    await this.client.del(`presence:${userId}`);
  }

  async refreshPresenceTtl(userId: string): Promise<void> {
    await this.client.expire(`presence:${userId}`, PRESENCE_TTL_S);
  }

  /**
   * Fetches presence data for multiple users in a single Redis pipeline round-trip.
   * Returns a map of userId → presence data (null if offline).
   */
  async getManyPresence(
    userIds: string[],
  ): Promise<Record<string, Record<string, string> | null>> {
    if (userIds.length === 0) return {};
    const pipeline = this.client.pipeline();
    userIds.forEach((id) => pipeline.hgetall(`presence:${id}`));
    const results = await pipeline.exec();
    const output: Record<string, Record<string, string> | null> = {};
    results?.forEach(([err, data], i) => {
      const uid = userIds[i];
      const map = data as Record<string, string>;
      output[uid] = !err && map && Object.keys(map).length > 0 ? map : null;
    });
    return output;
  }

  // ── Station Listeners ─────────────────────────────────────────────────────
  // Sorted set: station:{stationId}:listeners → score = last_active epoch ms
  // Membership is TTL-equivalent: members with score < (now - 300s) are stale.

  async addStationListener(stationId: string, userId: string): Promise<void> {
    const now = Date.now();
    await Promise.all([
      this.client.zadd(`station:${stationId}:listeners`, now, userId),
      // Prune stale members while we're here (cheap maintenance)
      this.client.zremrangebyscore(`station:${stationId}:listeners`, '-inf', now - PRESENCE_TTL_MS),
    ]);
  }

  async removeStationListener(stationId: string, userId: string): Promise<void> {
    await this.client.zrem(`station:${stationId}:listeners`, userId);
  }

  async getActiveListenerCount(stationId: string): Promise<number> {
    const minScore = Date.now() - PRESENCE_TTL_MS;
    return this.client.zcount(`station:${stationId}:listeners`, minScore, '+inf');
  }

  async getActiveListeners(stationId: string): Promise<string[]> {
    const minScore = Date.now() - PRESENCE_TTL_MS;
    return this.client.zrangebyscore(`station:${stationId}:listeners`, minScore, '+inf');
  }

  // ── Recent Occupants ──────────────────────────────────────────────────────
  // Sorted set: station:{stationId}:recent → score = last_seen epoch ms
  // Used to tell a reloading user (was here moments ago) apart from a brand-new
  // arrival to an empty station (e.g. clicking a notification). The first must
  // inherit the running broadcast; the second must trigger an instant reset.

  async markRecentOccupant(stationId: string, userId: string): Promise<void> {
    const key = `station:${stationId}:recent`;
    const now = Date.now();
    await Promise.all([
      this.client.zadd(key, now, userId),
      this.client.expire(key, RECENT_OCCUPANT_TTL_S),
      // Prune entries older than the TTL while we're here so the set never
      // grows past the active recent population.
      this.client.zremrangebyscore(key, '-inf', now - RECENT_OCCUPANT_TTL_S * 1000),
    ]);
  }

  async isRecentOccupant(stationId: string, userId: string, withinMs: number): Promise<boolean> {
    const key = `station:${stationId}:recent`;
    const raw = await this.client.zscore(key, userId);
    if (!raw) return false;
    const score = parseInt(raw, 10);
    if (!Number.isFinite(score)) return false;
    return score >= Date.now() - withinMs;
  }

  // ── Station Playback Session ───────────────────────────────────────────────

  async getStationSession(stationId: string): Promise<StationSession | null> {
    const raw = await this.client.get(`station:${stationId}:session`);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<StationSession>;
      if (
        !parsed
        || !Array.isArray(parsed.queue)
        || !Array.isArray(parsed.durationsSeconds)
        || !Number.isFinite(parsed.startedAtMs)
        || !Number.isFinite(parsed.version)
      ) {
        return null;
      }

      const queue = parsed.queue.filter((songId): songId is string => typeof songId === 'string' && songId.length > 0);
      const durationsSeconds = parsed.durationsSeconds
        .filter((seconds): seconds is number => Number.isFinite(seconds) && seconds > 0)
        .map((seconds) => Math.floor(seconds));

      if (queue.length === 0 || queue.length !== durationsSeconds.length) return null;

      const session: StationSession = {
        stationId,
        startedAtMs: Math.floor(parsed.startedAtMs),
        queue,
        durationsSeconds,
        version: Math.max(1, Math.floor(parsed.version)),
      };
      return session;
    } catch {
      return null;
    }
  }

  async setStationSession(session: StationSession): Promise<void> {
    await this.client.set(`station:${session.stationId}:session`, JSON.stringify(session));
  }

  async clearStationSession(stationId: string): Promise<void> {
    await this.client.del(`station:${stationId}:session`);
  }

  /**
   * Returns the version that the NEXT session for this station should start
   * with. Defaults to 1 when never reset. Bumped by resetStationSession when
   * the audience drains (count===0) or stale cleanup runs — survives session
   * deletion so the new audience cannot see comments from the previous one.
   */
  async getNextStationVersion(stationId: string): Promise<number> {
    const raw = await this.client.get(`station:${stationId}:nextVersion`);
    if (!raw) return 1;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  }

  /**
   * Atomically resets a station: clears the playback session AND bumps the
   * stored nextVersion to max(currentSession.version + 1, currentNextVersion).
   * Idempotent — running it twice does not double-bump.
   */
  async resetStationSession(stationId: string): Promise<void> {
    const [session, currentNext] = await Promise.all([
      this.getStationSession(stationId),
      this.getNextStationVersion(stationId),
    ]);
    const fromSession = (session?.version ?? 0) + 1;
    const newNextVersion = Math.max(fromSession, currentNext);
    await Promise.all([
      this.client.set(`station:${stationId}:nextVersion`, String(newNextVersion)),
      this.client.del(`station:${stationId}:session`),
    ]);
  }

  async tryAcquireLock(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(lockKey, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(lockKey: string, token: string): Promise<void> {
    await this.client.eval(LOCK_RELEASE_SCRIPT, 1, lockKey, token);
  }

  // ── Notification Badges ───────────────────────────────────────────────────

  async incrementNotificationBadge(userId: string): Promise<number> {
    return this.client.incr(`badge:notifications:${userId}`);
  }

  async getNotificationBadge(userId: string): Promise<number> {
    const val = await this.client.get(`badge:notifications:${userId}`);
    return val ? parseInt(val, 10) : 0;
  }

  async clearNotificationBadge(userId: string): Promise<void> {
    await this.client.del(`badge:notifications:${userId}`);
  }

  async incrementFriendBadge(userId: string): Promise<number> {
    return this.client.incr(`badge:friends:${userId}`);
  }

  async getFriendBadge(userId: string): Promise<number> {
    const val = await this.client.get(`badge:friends:${userId}`);
    return val ? parseInt(val, 10) : 0;
  }

  async clearFriendBadge(userId: string): Promise<void> {
    await this.client.del(`badge:friends:${userId}`);
  }

  // ── Station Cleanup ───────────────────────────────────────────────────────
  // Used by StationCleanupService to sweep idle stations every 5 minutes.

  /**
   * Scans all Redis keys matching `station:*:listeners` using SCAN (non-blocking).
   * Returns the full list of matching keys.
   */
  async scanStationListenerKeys(): Promise<string[]> {
    if (!this.client) {
      this.logger.warn('Redis client not ready yet, skipping station listener scan');
      return [];
    }

    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        'MATCH', 'station:*:listeners',
        'COUNT', '100',
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    return keys;
  }

  async getActiveStationIds(): Promise<string[]> {
    const keys = await this.scanStationListenerKeys();
    const ids = new Set<string>();
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length === 3 && parts[0] === 'station' && parts[2] === 'listeners' && parts[1]) {
        ids.add(parts[1]);
      }
    }
    return Array.from(ids);
  }

  /**
   * Removes stale members (score < now - 300s) from a station listener sorted set.
   * If the set is empty after pruning, deletes the key entirely.
   * Returns the number of remaining active listeners.
   */
  async pruneStationListeners(stationId: string): Promise<number> {
    const key      = `station:${stationId}:listeners`;
    const staleMax = Date.now() - PRESENCE_TTL_MS;

    await this.client.zremrangebyscore(key, '-inf', staleMax);

    const remaining = await this.client.zcard(key);
    if (remaining === 0) {
      await this.client.del(key);
      // Bump version + clear session in one shot — keeps stale-cleanup path
      // aligned with the gateway's count===0 reset path. Also drops the
      // recent-occupants set so the station is fully cold for the next visitor.
      await Promise.all([
        this.resetStationSession(stationId),
        this.client.del(`station:${stationId}:recent`),
      ]);
    }

    return remaining;
  }
}
