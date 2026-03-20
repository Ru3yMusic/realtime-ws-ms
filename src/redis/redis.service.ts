import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const PRESENCE_TTL_MS = 300_000; // 5 min in milliseconds (for ZADD score pruning)
const PRESENCE_TTL_S  = 300;     // 5 min in seconds (for Hash TTL)

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis({
      host:     this.config.get<string>('redis.host'),
      port:     this.config.get<number>('redis.port'),
      password: this.config.get<string | undefined>('redis.password'),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
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
}
