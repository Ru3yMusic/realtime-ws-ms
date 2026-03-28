import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

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
    await Promise.all([
      this.redis.removePresence(userId),
      this.redis.removeStationListener(stationId, userId),
    ]);
  }

  async refreshHeartbeat(userId: string, stationId: string, songId: string): Promise<void> {
    await Promise.all([
      this.redis.refreshPresenceTtl(userId),
      this.redis.addStationListener(stationId, userId), // refreshes ZADD score
    ]);
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
