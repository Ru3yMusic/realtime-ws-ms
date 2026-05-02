import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  const redis = {
    setPresence: jest.fn(),
    addStationListener: jest.fn(),
    removePresence: jest.fn(),
    removeStationListener: jest.fn(),
    markRecentOccupant: jest.fn(),
    isRecentOccupant: jest.fn(),
    getPresence: jest.fn(),
    getActiveListenerCount: jest.fn(),
    getActiveListeners: jest.fn(),
    getActiveStationIds: jest.fn(),
    getManyPresence: jest.fn(),
    getStationSession: jest.fn(),
    setStationSession: jest.fn(),
    clearStationSession: jest.fn(),
    resetStationSession: jest.fn(),
    getNextStationVersion: jest.fn(),
    tryAcquireLock: jest.fn(),
    releaseLock: jest.fn(),
  };

  let service: PresenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PresenceService(redis as any);
  });

  it('joinStation writes presence and station listener', async () => {
    redis.setPresence.mockResolvedValue(undefined);
    redis.addStationListener.mockResolvedValue(undefined);

    await service.joinStation('u1', 's1', 'song1');

    expect(redis.setPresence).toHaveBeenCalledWith('u1', 's1', 'song1');
    expect(redis.addStationListener).toHaveBeenCalledWith('s1', 'u1');
  });

  it('leaveStation removes both presence and station listener', async () => {
    redis.markRecentOccupant.mockResolvedValue(undefined);
    redis.removePresence.mockResolvedValue(undefined);
    redis.removeStationListener.mockResolvedValue(undefined);

    await service.leaveStation('u1', 's1');

    expect(redis.markRecentOccupant).toHaveBeenCalledWith('s1', 'u1');
    expect(redis.removePresence).toHaveBeenCalledWith('u1');
    expect(redis.removeStationListener).toHaveBeenCalledWith('s1', 'u1');
  });

  it('refreshHeartbeat refreshes ttl and listener score', async () => {
    redis.setPresence.mockResolvedValue(undefined);
    redis.addStationListener.mockResolvedValue(undefined);

    await service.refreshHeartbeat('u1', 's1', 'song1');

    expect(redis.setPresence).toHaveBeenCalledWith('u1', 's1', 'song1');
    expect(redis.addStationListener).toHaveBeenCalledWith('s1', 'u1');
  });

  it('delegates getPresence/getListenerCount/getListeners', async () => {
    redis.getPresence.mockResolvedValue({ station_id: 's1', song_id: 'song1' });
    redis.getActiveListenerCount.mockResolvedValue(3);
    redis.getActiveListeners.mockResolvedValue(['u1', 'u2', 'u3']);

    await expect(service.getPresence('u1')).resolves.toEqual({ station_id: 's1', song_id: 'song1' });
    await expect(service.getListenerCount('s1')).resolves.toBe(3);
    await expect(service.getListeners('s1')).resolves.toEqual(['u1', 'u2', 'u3']);
  });

  it('getBulkPresence maps existing users as online and missing as offline', async () => {
    redis.getManyPresence.mockResolvedValue({
      u1: { station_id: 's1', song_id: 'song1', last_active: '2026-01-01T00:00:00.000Z' },
      u2: null,
    });

    const result = await service.getBulkPresence(['u1', 'u2']);

    expect(result).toEqual({
      u1: {
        online: true,
        station_id: 's1',
        song_id: 'song1',
        last_active: '2026-01-01T00:00:00.000Z',
      },
      u2: { online: false },
    });
  });

  // ── thin delegations ────────────────────────────────────────────────────────

  it('isRecentOccupant delegates with the given window', async () => {
    redis.isRecentOccupant.mockResolvedValue(true);

    await expect(service.isRecentOccupant('s1', 'u1', 30_000)).resolves.toBe(true);
    expect(redis.isRecentOccupant).toHaveBeenCalledWith('s1', 'u1', 30_000);
  });

  it('refreshHeartbeat defaults songId to empty string when omitted', async () => {
    redis.setPresence.mockResolvedValue(undefined);
    redis.addStationListener.mockResolvedValue(undefined);

    await service.refreshHeartbeat('u1', 's1');

    expect(redis.setPresence).toHaveBeenCalledWith('u1', 's1', '');
  });

  it('getActiveStationIds delegates to redis', async () => {
    redis.getActiveStationIds.mockResolvedValue(['s1', 's2']);

    await expect(service.getActiveStationIds()).resolves.toEqual(['s1', 's2']);
  });

  // ── station session lifecycle ───────────────────────────────────────────────

  it('getStationSession delegates and returns null when not present', async () => {
    redis.getStationSession.mockResolvedValue(null);

    await expect(service.getStationSession('s1')).resolves.toBeNull();
    expect(redis.getStationSession).toHaveBeenCalledWith('s1');
  });

  it('setStationSession persists the full session payload', async () => {
    redis.setStationSession.mockResolvedValue(undefined);
    const session = { stationId: 's1', startedAt: 1000, queue: ['a', 'b'], version: 1 } as any;

    await service.setStationSession(session);

    expect(redis.setStationSession).toHaveBeenCalledWith(session);
  });

  it('clearStationSession deletes the session by stationId', async () => {
    redis.clearStationSession.mockResolvedValue(undefined);

    await service.clearStationSession('s1');

    expect(redis.clearStationSession).toHaveBeenCalledWith('s1');
  });

  it('resetStationSession bumps version atomically (different from clear)', async () => {
    redis.resetStationSession.mockResolvedValue(undefined);

    await service.resetStationSession('s1');

    expect(redis.resetStationSession).toHaveBeenCalledWith('s1');
  });

  it('getNextStationVersion returns the bumped version counter', async () => {
    redis.getNextStationVersion.mockResolvedValue(7);

    await expect(service.getNextStationVersion('s1')).resolves.toBe(7);
  });

  // ── distributed locks ──────────────────────────────────────────────────────

  it('tryAcquireLock returns true when redis grants the lock', async () => {
    redis.tryAcquireLock.mockResolvedValue(true);

    await expect(service.tryAcquireLock('lock:s1', 'tok-1', 5000)).resolves.toBe(true);
    expect(redis.tryAcquireLock).toHaveBeenCalledWith('lock:s1', 'tok-1', 5000);
  });

  it('tryAcquireLock returns false when redis denies', async () => {
    redis.tryAcquireLock.mockResolvedValue(false);

    await expect(service.tryAcquireLock('lock:s1', 'tok-1', 5000)).resolves.toBe(false);
  });

  it('releaseLock delegates with key and token', async () => {
    redis.releaseLock.mockResolvedValue(undefined);

    await service.releaseLock('lock:s1', 'tok-1');

    expect(redis.releaseLock).toHaveBeenCalledWith('lock:s1', 'tok-1');
  });
});
