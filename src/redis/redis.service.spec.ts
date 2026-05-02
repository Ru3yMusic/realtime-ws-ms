import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

const mockPipeline = {
  hgetall: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

const mockClient = {
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn(),
  hset: jest.fn().mockResolvedValue(undefined),
  expire: jest.fn().mockResolvedValue(undefined),
  hgetall: jest.fn(),
  del: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue('OK'),
  pipeline: jest.fn(() => mockPipeline),
  zadd: jest.fn().mockResolvedValue(undefined),
  zremrangebyscore: jest.fn().mockResolvedValue(undefined),
  zrem: jest.fn().mockResolvedValue(undefined),
  zcount: jest.fn(),
  zrangebyscore: jest.fn(),
  zscore: jest.fn(),
  incr: jest.fn(),
  get: jest.fn(),
  scan: jest.fn(),
  zcard: jest.fn(),
  eval: jest.fn().mockResolvedValue(1),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => mockClient),
}));

describe('RedisService', () => {
  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        'redis.host': 'localhost',
        'redis.port': 6379,
        'redis.password': 'pass',
      };
      return map[key];
    }),
  } as unknown as ConfigService;

  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RedisService(config);
    service.onModuleInit();
  });

  it('creates redis client from config and registers listeners', () => {
    expect(Redis).toHaveBeenCalledWith({ host: 'localhost', port: 6379, password: 'pass' });
    expect(mockClient.on).toHaveBeenCalledTimes(4);
  });

  it('quits redis client on module destroy', async () => {
    await service.onModuleDestroy();
    expect(mockClient.quit).toHaveBeenCalled();
  });

  it('ping returns true only for PONG and false on error', async () => {
    mockClient.ping.mockResolvedValueOnce('PONG').mockResolvedValueOnce('NOPE').mockRejectedValueOnce(new Error('down'));

    await expect(service.ping()).resolves.toBe(true);
    await expect(service.ping()).resolves.toBe(false);
    await expect(service.ping()).resolves.toBe(false);
  });

  it('set/get/remove/refresh presence delegates to redis keys', async () => {
    mockClient.hgetall.mockResolvedValueOnce({ station_id: 's1', song_id: 'song1' }).mockResolvedValueOnce({});

    await service.setPresence('u1', 's1', 'song1');
    await expect(service.getPresence('u1')).resolves.toEqual({ station_id: 's1', song_id: 'song1' });
    await expect(service.getPresence('u1')).resolves.toBeNull();
    await service.refreshPresenceTtl('u1');
    await service.removePresence('u1');

    expect(mockClient.hset).toHaveBeenCalledWith('presence:u1', expect.objectContaining({ station_id: 's1', song_id: 'song1' }));
    expect(mockClient.expire).toHaveBeenCalledWith('presence:u1', 300);
    expect(mockClient.del).toHaveBeenCalledWith('presence:u1');
  });

  it('getManyPresence uses pipeline and maps empty/error entries to null', async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, { station_id: 's1' }],
      [null, {}],
      [new Error('boom'), { station_id: 's3' }],
    ]);

    const result = await service.getManyPresence(['u1', 'u2', 'u3']);

    expect(mockPipeline.hgetall).toHaveBeenCalledWith('presence:u1');
    expect(mockPipeline.hgetall).toHaveBeenCalledWith('presence:u2');
    expect(mockPipeline.hgetall).toHaveBeenCalledWith('presence:u3');
    expect(result).toEqual({
      u1: { station_id: 's1' },
      u2: null,
      u3: null,
    });
  });

  it('getManyPresence returns empty object for empty input', async () => {
    await expect(service.getManyPresence([])).resolves.toEqual({});
    expect(mockClient.pipeline).not.toHaveBeenCalled();
  });

  it('handles station listener operations and score-based queries', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockClient.zcount.mockResolvedValue(7);
    mockClient.zrangebyscore.mockResolvedValue(['u1', 'u2']);

    await service.addStationListener('s1', 'u1');
    await service.removeStationListener('s1', 'u1');
    await expect(service.getActiveListenerCount('s1')).resolves.toBe(7);
    await expect(service.getActiveListeners('s1')).resolves.toEqual(['u1', 'u2']);

    expect(mockClient.zadd).toHaveBeenCalledWith('station:s1:listeners', 1_000_000, 'u1');
    expect(mockClient.zremrangebyscore).toHaveBeenCalledWith('station:s1:listeners', '-inf', 700000);
    expect(mockClient.zrem).toHaveBeenCalledWith('station:s1:listeners', 'u1');
    expect(mockClient.zcount).toHaveBeenCalledWith('station:s1:listeners', 700000, '+inf');
    expect(mockClient.zrangebyscore).toHaveBeenCalledWith('station:s1:listeners', 700000, '+inf');
  });

  it('handles notification and friend badges', async () => {
    mockClient.incr.mockResolvedValueOnce(2).mockResolvedValueOnce(4);
    mockClient.get.mockResolvedValueOnce('3').mockResolvedValueOnce(null).mockResolvedValueOnce('5').mockResolvedValueOnce(null);

    await expect(service.incrementNotificationBadge('u1')).resolves.toBe(2);
    await expect(service.getNotificationBadge('u1')).resolves.toBe(3);
    await expect(service.getNotificationBadge('u1')).resolves.toBe(0);
    await service.clearNotificationBadge('u1');

    await expect(service.incrementFriendBadge('u1')).resolves.toBe(4);
    await expect(service.getFriendBadge('u1')).resolves.toBe(5);
    await expect(service.getFriendBadge('u1')).resolves.toBe(0);
    await service.clearFriendBadge('u1');

    expect(mockClient.del).toHaveBeenCalledWith('badge:notifications:u1');
    expect(mockClient.del).toHaveBeenCalledWith('badge:friends:u1');
  });

  it('scanStationListenerKeys iterates cursor until zero', async () => {
    mockClient.scan
      .mockResolvedValueOnce(['1', ['station:a:listeners']])
      .mockResolvedValueOnce(['0', ['station:b:listeners']]);

    await expect(service.scanStationListenerKeys()).resolves.toEqual([
      'station:a:listeners',
      'station:b:listeners',
    ]);
  });

  it('pruneStationListeners deletes key when no members remain', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockClient.zcard.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    mockClient.get.mockResolvedValue(null); // for getStationSession + getNextStationVersion

    await expect(service.pruneStationListeners('dead')).resolves.toBe(0);
    await expect(service.pruneStationListeners('alive')).resolves.toBe(2);

    expect(mockClient.zremrangebyscore).toHaveBeenCalledWith('station:dead:listeners', '-inf', 700000);
    expect(mockClient.del).toHaveBeenCalledWith('station:dead:listeners');
    expect(mockClient.del).toHaveBeenCalledWith('station:dead:session');
    expect(mockClient.del).not.toHaveBeenCalledWith('station:alive:listeners');
  });

  // ── Recent occupants ────────────────────────────────────────────────────────

  it('markRecentOccupant zadds, sets TTL, and prunes old entries', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    await service.markRecentOccupant('s1', 'u1');

    expect(mockClient.zadd).toHaveBeenCalledWith('station:s1:recent', 2_000_000, 'u1');
    expect(mockClient.expire).toHaveBeenCalledWith('station:s1:recent', 120);
    expect(mockClient.zremrangebyscore).toHaveBeenCalledWith(
      'station:s1:recent', '-inf', 2_000_000 - 120 * 1000,
    );
  });

  it('isRecentOccupant returns false when zscore returns null', async () => {
    mockClient.zscore.mockResolvedValue(null);

    await expect(service.isRecentOccupant('s1', 'ghost', 30_000)).resolves.toBe(false);
  });

  it('isRecentOccupant returns false when score is not finite', async () => {
    mockClient.zscore.mockResolvedValue('not-a-number');

    await expect(service.isRecentOccupant('s1', 'u1', 30_000)).resolves.toBe(false);
  });

  it('isRecentOccupant returns true when score within window', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    mockClient.zscore.mockResolvedValue('1_990_000'.replace(/_/g, ''));

    await expect(service.isRecentOccupant('s1', 'u1', 30_000)).resolves.toBe(true);
  });

  it('isRecentOccupant returns false when score is older than window', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    mockClient.zscore.mockResolvedValue('1000000'); // 1M ms ago, way past 30s window

    await expect(service.isRecentOccupant('s1', 'u1', 30_000)).resolves.toBe(false);
  });

  // ── Station session ─────────────────────────────────────────────────────────

  it('getStationSession returns null when key absent', async () => {
    mockClient.get.mockResolvedValueOnce(null);
    await expect(service.getStationSession('s1')).resolves.toBeNull();
  });

  it('getStationSession returns null on JSON parse error', async () => {
    mockClient.get.mockResolvedValueOnce('not-json{{{');
    await expect(service.getStationSession('s1')).resolves.toBeNull();
  });

  it('getStationSession returns null when shape is invalid', async () => {
    mockClient.get.mockResolvedValueOnce(JSON.stringify({ queue: 'not-array' }));
    await expect(service.getStationSession('s1')).resolves.toBeNull();
  });

  it('getStationSession returns null when queue is empty after filtering', async () => {
    mockClient.get.mockResolvedValueOnce(JSON.stringify({
      queue: ['', null],
      durationsSeconds: [10, 20],
      startedAtMs: 1000,
      version: 1,
    }));
    await expect(service.getStationSession('s1')).resolves.toBeNull();
  });

  it('getStationSession returns null when queue/duration lengths differ', async () => {
    mockClient.get.mockResolvedValueOnce(JSON.stringify({
      queue: ['a', 'b'],
      durationsSeconds: [10, -5, 0], // negative/zero filtered out → length 1, mismatch
      startedAtMs: 1000,
      version: 1,
    }));
    await expect(service.getStationSession('s1')).resolves.toBeNull();
  });

  it('getStationSession returns valid session with normalised fields', async () => {
    mockClient.get.mockResolvedValueOnce(JSON.stringify({
      queue: ['a', 'b'],
      durationsSeconds: [10.7, 20.3],
      startedAtMs: 1000.9,
      version: 0.5, // becomes max(1, floor) = 1
    }));

    await expect(service.getStationSession('s1')).resolves.toEqual({
      stationId: 's1',
      startedAtMs: 1000,
      queue: ['a', 'b'],
      durationsSeconds: [10, 20],
      version: 1,
    });
  });

  it('setStationSession serializes session to JSON', async () => {
    const session = {
      stationId: 's1', startedAtMs: 1000,
      queue: ['a'], durationsSeconds: [10], version: 1,
    };

    await service.setStationSession(session);

    expect(mockClient.set).toHaveBeenCalledWith(
      'station:s1:session', JSON.stringify(session),
    );
  });

  it('clearStationSession deletes session key', async () => {
    await service.clearStationSession('s1');
    expect(mockClient.del).toHaveBeenCalledWith('station:s1:session');
  });

  // ── Station versions ────────────────────────────────────────────────────────

  it('getNextStationVersion returns 1 when key absent', async () => {
    mockClient.get.mockResolvedValueOnce(null);
    await expect(service.getNextStationVersion('s1')).resolves.toBe(1);
  });

  it('getNextStationVersion returns parsed value when valid', async () => {
    mockClient.get.mockResolvedValueOnce('5');
    await expect(service.getNextStationVersion('s1')).resolves.toBe(5);
  });

  it('getNextStationVersion returns 1 when stored value is invalid', async () => {
    mockClient.get.mockResolvedValueOnce('garbage');
    await expect(service.getNextStationVersion('s1')).resolves.toBe(1);
  });

  it('getNextStationVersion returns 1 when stored value is below 1', async () => {
    mockClient.get.mockResolvedValueOnce('0');
    await expect(service.getNextStationVersion('s1')).resolves.toBe(1);
  });

  it('resetStationSession bumps version to max(session+1, currentNext)', async () => {
    // First mock: getStationSession returns valid session with version=3
    mockClient.get
      .mockResolvedValueOnce(JSON.stringify({
        queue: ['a'], durationsSeconds: [10], startedAtMs: 1000, version: 3,
      }))
      .mockResolvedValueOnce('2'); // currentNext = 2 → fromSession=4 wins

    await service.resetStationSession('s1');

    expect(mockClient.set).toHaveBeenCalledWith('station:s1:nextVersion', '4');
    expect(mockClient.del).toHaveBeenCalledWith('station:s1:session');
  });

  it('resetStationSession picks currentNext when greater than session+1', async () => {
    mockClient.get
      .mockResolvedValueOnce(null)        // no session → fromSession = 0+1 = 1
      .mockResolvedValueOnce('10');       // currentNext = 10 wins

    await service.resetStationSession('s1');

    expect(mockClient.set).toHaveBeenCalledWith('station:s1:nextVersion', '10');
  });

  // ── Distributed locks ───────────────────────────────────────────────────────

  it('tryAcquireLock returns true on OK response', async () => {
    mockClient.set.mockResolvedValueOnce('OK');
    await expect(service.tryAcquireLock('lk', 'tok', 5000)).resolves.toBe(true);
    expect(mockClient.set).toHaveBeenCalledWith('lk', 'tok', 'PX', 5000, 'NX');
  });

  it('tryAcquireLock returns false when key already held', async () => {
    mockClient.set.mockResolvedValueOnce(null);
    await expect(service.tryAcquireLock('lk', 'tok', 5000)).resolves.toBe(false);
  });

  it('releaseLock runs lua script with key + token', async () => {
    await service.releaseLock('lk', 'tok');
    expect(mockClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('GET'), 1, 'lk', 'tok',
    );
  });

  // ── Active station IDs ──────────────────────────────────────────────────────

  it('getActiveStationIds extracts stationId from listener keys, dedupes', async () => {
    mockClient.scan
      .mockResolvedValueOnce(['1', ['station:s1:listeners', 'station:s2:listeners']])
      .mockResolvedValueOnce(['0', ['station:s1:listeners', 'invalid:key']]);

    const result = await service.getActiveStationIds();

    expect(result).toContain('s1');
    expect(result).toContain('s2');
    expect(result).not.toContain('invalid');
    expect(new Set(result).size).toBe(result.length);
  });

  it('scanStationListenerKeys returns empty when client not initialised', async () => {
    const freshService = new RedisService(config);
    // Do NOT call onModuleInit — client stays undefined
    await expect(freshService.scanStationListenerKeys()).resolves.toEqual([]);
  });
});
