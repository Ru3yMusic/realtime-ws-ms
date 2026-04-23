import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  const redis = {
    setPresence: jest.fn(),
    addStationListener: jest.fn(),
    removePresence: jest.fn(),
    removeStationListener: jest.fn(),
    refreshPresenceTtl: jest.fn(),
    getPresence: jest.fn(),
    getActiveListenerCount: jest.fn(),
    getActiveListeners: jest.fn(),
    getManyPresence: jest.fn(),
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
    redis.removePresence.mockResolvedValue(undefined);
    redis.removeStationListener.mockResolvedValue(undefined);

    await service.leaveStation('u1', 's1');

    expect(redis.removePresence).toHaveBeenCalledWith('u1');
    expect(redis.removeStationListener).toHaveBeenCalledWith('s1', 'u1');
  });

  it('refreshHeartbeat refreshes ttl and listener score', async () => {
    redis.refreshPresenceTtl.mockResolvedValue(undefined);
    redis.addStationListener.mockResolvedValue(undefined);

    await service.refreshHeartbeat('u1', 's1', 'song1');

    expect(redis.refreshPresenceTtl).toHaveBeenCalledWith('u1');
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
});
