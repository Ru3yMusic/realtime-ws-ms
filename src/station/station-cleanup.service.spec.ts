import { Test, TestingModule } from '@nestjs/testing';
import { StationCleanupService } from './station-cleanup.service';
import { RedisService } from '../redis/redis.service';

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockRedis = {
  scanStationListenerKeys: jest.fn(),
  pruneStationListeners:   jest.fn(),
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('StationCleanupService', () => {
  let service: StationCleanupService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StationCleanupService,
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<StationCleanupService>(StationCleanupService);
    jest.clearAllMocks();
  });

  // Prevent setInterval from firing during tests
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('runCleanup', () => {
    it('does nothing when there are no station listener keys', async () => {
      mockRedis.scanStationListenerKeys.mockResolvedValue([]);

      await service.runCleanup();

      expect(mockRedis.pruneStationListeners).not.toHaveBeenCalled();
    });

    it('calls pruneStationListeners for each station key found', async () => {
      mockRedis.scanStationListenerKeys.mockResolvedValue([
        'station:abc-1:listeners',
        'station:abc-2:listeners',
      ]);
      mockRedis.pruneStationListeners.mockResolvedValue(2); // 2 active listeners remaining

      await service.runCleanup();

      expect(mockRedis.pruneStationListeners).toHaveBeenCalledTimes(2);
      expect(mockRedis.pruneStationListeners).toHaveBeenCalledWith('abc-1');
      expect(mockRedis.pruneStationListeners).toHaveBeenCalledWith('abc-2');
    });

    it('counts stations that become empty after pruning (remaining=0)', async () => {
      mockRedis.scanStationListenerKeys.mockResolvedValue([
        'station:dead-1:listeners',
        'station:dead-2:listeners',
        'station:active-1:listeners',
      ]);
      mockRedis.pruneStationListeners
        .mockResolvedValueOnce(0)  // dead-1 — empty, should be deleted by RedisService
        .mockResolvedValueOnce(0)  // dead-2 — empty
        .mockResolvedValueOnce(3); // active-1 — still has listeners

      // runCleanup should complete without throwing
      await expect(service.runCleanup()).resolves.toBeUndefined();

      expect(mockRedis.pruneStationListeners).toHaveBeenCalledTimes(3);
    });

    it('skips keys that do not match the station:*:listeners pattern', async () => {
      mockRedis.scanStationListenerKeys.mockResolvedValue([
        'station:valid:listeners',
        'some:unexpected:key',        // malformed — extractStationId returns null
      ]);
      mockRedis.pruneStationListeners.mockResolvedValue(1);

      await service.runCleanup();

      // Only the valid key should trigger a prune
      expect(mockRedis.pruneStationListeners).toHaveBeenCalledTimes(1);
      expect(mockRedis.pruneStationListeners).toHaveBeenCalledWith('valid');
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('registers a periodic interval on init', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        5 * 60 * 1000,
      );

      service.onModuleDestroy(); // cleanup
    });

    it('clears the interval on destroy', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      service.onModuleInit();
      service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});
