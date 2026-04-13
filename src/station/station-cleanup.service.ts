import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — matches presence TTL

/**
 * StationCleanupService — periodic sweeper for idle station listener sets.
 *
 * Problem: `addStationListener()` already prunes stale members on every heartbeat,
 * but sorted-set keys for stations where ALL users have silently dropped remain in
 * Redis indefinitely (no one to trigger a prune).
 *
 * Solution: scan `station:*:listeners` every 5 min, prune stale members, and
 * delete keys that become empty. Uses Redis SCAN (non-blocking cursor) so it
 * never locks the instance.
 */
@Injectable()
export class StationCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StationCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runCleanup().catch((err) =>
        this.logger.error('Station cleanup cycle failed', err),
      );
    }, CLEANUP_INTERVAL_MS);

    this.logger.log(`Station cleanup scheduled every ${CLEANUP_INTERVAL_MS / 1000}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One full cleanup cycle:
   *  1. SCAN Redis for all `station:*:listeners` sorted-set keys.
   *  2. For each key, remove entries with score < (now - 300s).
   *  3. If the set is empty after pruning, delete the key.
   */
  async runCleanup(): Promise<void> {
    const keys = await this.redis.scanStationListenerKeys();

    if (keys.length === 0) {
      this.logger.debug('Cleanup: no station listener keys found');
      return;
    }

    let pruned = 0;
    let removed = 0;

    for (const key of keys) {
      // Key format: station:{stationId}:listeners
      const stationId = this.extractStationId(key);
      if (!stationId) continue;

      const remaining = await this.redis.pruneStationListeners(stationId);

      pruned++;
      if (remaining === 0) removed++;
    }

    this.logger.log(
      `Cleanup complete — checked: ${pruned}, empty keys removed: ${removed}`,
    );
  }

  private extractStationId(key: string): string | null {
    // key = "station:{stationId}:listeners"
    const match = key.match(/^station:(.+):listeners$/);
    return match ? match[1] : null;
  }
}
