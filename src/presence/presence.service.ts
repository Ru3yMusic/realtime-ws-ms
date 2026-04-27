import { Injectable } from '@nestjs/common';
import { RedisService, StationSession } from '../redis/redis.service';

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  async joinStation(userId: string, stationId: string, songId: string): Promise<void> {
    await Promise.all([
      this.redis.setPresence(userId, stationId, songId),
      this.redis.addStationListener(stationId, userId),
    ]);
  }

  async leaveStation(userId: string, stationId: string): Promise<void> {
    // Mark the user as a recent occupant BEFORE removing them from the active
    // listeners set — and AWAIT the mark to land before the listener removal
    // even starts. Running them in parallel was racy: if removeListener won
    // the round-trip, a concurrent join handler could observe count===0 with
    // isRecentOccupant=false and trigger an erroneous fresh-entry reset.
    // With strict sequencing, any later isRecentOccupant call is guaranteed
    // to see the recent mark, so reload always inherits the running session.
    await this.redis.markRecentOccupant(stationId, userId);
    await Promise.all([
      this.redis.removePresence(userId),
      this.redis.removeStationListener(stationId, userId),
    ]);
  }

  async isRecentOccupant(stationId: string, userId: string, withinMs: number): Promise<boolean> {
    return this.redis.isRecentOccupant(stationId, userId, withinMs);
  }

  // Heartbeat reuses the join write-path on purpose: addStationListener is an
  // idempotent ZADD that refreshes the score, which is exactly what we want
  // when a still-connected client pings to extend its presence TTL.
  async refreshHeartbeat(userId: string, stationId: string, songId = ''): Promise<void> {
    await this.joinStation(userId, stationId, songId);
  }

  async getPresence(userId: string): Promise<Record<string, string> | null> {
    return this.redis.getPresence(userId);
  }

  async getListenerCount(stationId: string): Promise<number> {
    return this.redis.getActiveListenerCount(stationId);
  }

  async getListeners(stationId: string): Promise<string[]> {
    return this.redis.getActiveListeners(stationId);
  }

  async getActiveStationIds(): Promise<string[]> {
    return this.redis.getActiveStationIds();
  }

  async getStationSession(stationId: string): Promise<StationSession | null> {
    return this.redis.getStationSession(stationId);
  }

  async setStationSession(session: StationSession): Promise<void> {
    await this.redis.setStationSession(session);
  }

  async clearStationSession(stationId: string): Promise<void> {
    await this.redis.clearStationSession(stationId);
  }

  /**
   * Atomically clears the station session AND bumps the stored nextVersion.
   * Use this — not clearStationSession — when the audience has fully reset
   * (count===0 or stale cleanup) so the next audience starts at a new version.
   */
  async resetStationSession(stationId: string): Promise<void> {
    await this.redis.resetStationSession(stationId);
  }

  async getNextStationVersion(stationId: string): Promise<number> {
    return this.redis.getNextStationVersion(stationId);
  }

  async tryAcquireLock(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    return this.redis.tryAcquireLock(lockKey, token, ttlMs);
  }

  async releaseLock(lockKey: string, token: string): Promise<void> {
    await this.redis.releaseLock(lockKey, token);
  }

  /**
   * Returns presence data for multiple user IDs in one Redis pipeline call.
   * Used by the "Chat estación" screen to show which friends are listening and where.
   */
  async getBulkPresence(
    userIds: string[],
  ): Promise<Record<string, { online: boolean; station_id?: string; song_id?: string; last_active?: string }>> {
    const raw = await this.redis.getManyPresence(userIds);
    const result: Record<string, any> = {};
    for (const [uid, data] of Object.entries(raw)) {
      result[uid] = data ? { online: true, ...data } : { online: false };
    }
    return result;
  }
}
