import { PresenceController } from './presence.controller';

describe('PresenceController', () => {
  const presence = {
    getPresence: jest.fn(),
    getListenerCount: jest.fn(),
    getListeners: jest.fn(),
    getBulkPresence: jest.fn(),
  };

  const socketState = {
    isOnline: jest.fn(),
  };

  let controller: PresenceController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PresenceController(presence as any, socketState as any);
  });

  it('getMyPresence returns merged response when redis presence exists', async () => {
    presence.getPresence.mockResolvedValue({ station_id: 's1', song_id: 'song1' });
    socketState.isOnline.mockReturnValue(false);

    await expect(controller.getMyPresence('u1')).resolves.toEqual({
      online: true,
      station_id: 's1',
      song_id: 'song1',
    });
  });

  it('getUserPresence falls back to socket online state when redis data is absent', async () => {
    presence.getPresence.mockResolvedValue(null);
    socketState.isOnline.mockReturnValue(true);

    await expect(controller.getUserPresence('u2')).resolves.toEqual({ online: true });
  });

  it('getStationListeners returns count and listener list', async () => {
    presence.getListenerCount.mockResolvedValue(2);
    presence.getListeners.mockResolvedValue(['u1', 'u2']);

    await expect(controller.getStationListeners('station-1')).resolves.toEqual({
      stationId: 'station-1',
      count: 2,
      listeners: ['u1', 'u2'],
    });
  });

  it('getBulkPresence ORs socket-state online with redis online', async () => {
    presence.getBulkPresence.mockResolvedValue({
      u1: { online: false },
      u2: { online: true, station_id: 's2', song_id: 'song2' },
      u3: { online: false },
    });
    socketState.isOnline.mockImplementation((id: string) => id === 'u1');

    const body = { userIds: ['u1', 'u2', 'u3', 'u4'] };
    const result = await controller.getBulkPresence(body as any);

    expect(result).toEqual({
      u1: { online: true },
      u2: { online: true, station_id: 's2', song_id: 'song2' },
      u3: { online: false },
      u4: { online: false },
    });
  });
});
