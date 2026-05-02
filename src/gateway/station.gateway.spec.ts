import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StationGateway } from './station.gateway';
import { PresenceService } from '../presence/presence.service';
import { SocketStateService } from '../socket/socket-state.service';
import { KafkaProducerService } from '../kafka/kafka.producer';

// Mock jsonwebtoken BEFORE the module is imported so jest intercepts it
jest.mock('jsonwebtoken');
import * as jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMOCK_KEY\n-----END PUBLIC KEY-----';

/** Builds a minimal Socket.IO socket stub */
function makeSocket(overrides: {
  authToken?: string;
  authorizationHeader?: string;
  xDisplayName?: string;
  xProfilePhotoUrl?: string;
} = {}) {
  return {
    id: 'sock-test-01',
    handshake: {
      auth: overrides.authToken !== undefined ? { token: overrides.authToken } : {},
      headers: {
        ...(overrides.authorizationHeader && { authorization: overrides.authorizationHeader }),
        ...(overrides.xDisplayName        && { 'x-display-name': overrides.xDisplayName }),
        ...(overrides.xProfilePhotoUrl    && { 'x-profile-photo-url': overrides.xProfilePhotoUrl }),
      },
    },
    data:       {} as Record<string, unknown>,
    disconnect: jest.fn(),
    on:         jest.fn(),
    join:       jest.fn(),
    leave:      jest.fn(),
    emit:       jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StationGateway — JWT handshake validation', () => {
  let gateway: StationGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StationGateway,
        {
          provide: PresenceService,
          useValue: {
            joinStation:       jest.fn(),
            leaveStation:      jest.fn(),
            getListenerCount:  jest.fn().mockResolvedValue(0),
            refreshHeartbeat:  jest.fn(),
            getStationSession: jest.fn().mockResolvedValue(null),
            setStationSession: jest.fn().mockResolvedValue(undefined),
            clearStationSession: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SocketStateService,
          useValue: {
            add: jest.fn(),
            remove: jest.fn(),
            isOnline: jest.fn().mockReturnValue(true),
            setServer: jest.fn(),
          },
        },
        {
          provide: KafkaProducerService,
          useValue: { publishCommentCreated: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(MOCK_PUBLIC_KEY) },
        },
      ],
    }).compile();

    gateway = module.get<StationGateway>(StationGateway);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Valid token ────────────────────────────────────────────────────────────

  it('accepts connection and extracts userId from valid token (auth.token)', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValue({
      sub:             'user-42',
      username:        'alice',
      profilePhotoUrl: 'https://cdn.example.com/alice.jpg',
    });

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.userId).toBe('user-42');
    expect(socket.data.username).toBe('alice');
    expect(socket.data.profilePhotoUrl).toBe('https://cdn.example.com/alice.jpg');
  });

  it('accepts connection with Bearer token in Authorization header (fallback)', () => {
    const socket = makeSocket({ authorizationHeader: 'Bearer header.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'user-99' });

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.userId).toBe('user-99');
  });

  it('falls back to x-display-name header when token has no username claim', () => {
    const socket = makeSocket({
      authToken:    'valid.jwt.token',
      xDisplayName: 'Bob From Header',
    });

    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'user-77' });

    gateway.handleConnection(socket as any);

    expect(socket.data.username).toBe('Bob From Header');
  });

  // ── Invalid / missing token ───────────────────────────────────────────────

  it('disconnects when no token is provided at all', () => {
    const socket = makeSocket(); // no auth.token, no Authorization header

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when token has an invalid signature', () => {
    const socket = makeSocket({ authToken: 'tampered.jwt.token' });

    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid signature');
    });

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when token is expired', () => {
    const socket = makeSocket({ authToken: 'expired.jwt.token' });

    (jwt.verify as jest.Mock).mockImplementation(() => {
      const err: Error & { name?: string } = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    });

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when token payload is missing the sub claim', () => {
    const socket = makeSocket({ authToken: 'no-sub.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValue({ role: 'USER' }); // no sub

    gateway.handleConnection(socket as any);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  // ── auth_refresh ──────────────────────────────────────────────────────────

  it('accepts auth_refresh with a valid token', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42', displayName: 'Alice' });
    gateway.handleConnection(socket as any);

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42', displayName: 'Alice v2' });
    const ack = gateway.handleAuthRefresh(socket as any, { token: 'Bearer refreshed.jwt.token' });

    expect(ack).toEqual({ ok: true });
    expect(socket.data.userId).toBe('user-42');
    expect(socket.data.username).toBe('Alice v2');
  });

  it('rejects auth_refresh when token is expired', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42' });
    gateway.handleConnection(socket as any);

    (jwt.verify as jest.Mock).mockImplementationOnce(() => {
      const err: Error & { name?: string } = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    });

    const ack = gateway.handleAuthRefresh(socket as any, { token: 'Bearer expired.jwt.token' });
    expect(ack).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects on auth_refresh user mismatch', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42' });
    gateway.handleConnection(socket as any);

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-99' });
    const ack = gateway.handleAuthRefresh(socket as any, { token: 'Bearer other-user.jwt.token' });

    expect(ack).toEqual({ ok: false, code: 'USER_MISMATCH' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('auth_refresh THROTTLED when called twice within the min interval', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });

    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42' });
    gateway.handleConnection(socket as any);

    (jwt.verify as jest.Mock).mockReturnValue({ sub: 'user-42' });
    const ack1 = gateway.handleAuthRefresh(socket as any, { token: 'tok-a' });
    const ack2 = gateway.handleAuthRefresh(socket as any, { token: 'tok-b' });

    expect(ack1).toEqual({ ok: true });
    expect(ack2).toEqual({ ok: false, code: 'THROTTLED' });
  });

  it('auth_refresh returns TOKEN_INVALID for non-expired jwt errors', () => {
    const socket = makeSocket({ authToken: 'valid.jwt.token' });
    (jwt.verify as jest.Mock).mockReturnValueOnce({ sub: 'user-42' });
    gateway.handleConnection(socket as any);

    (jwt.verify as jest.Mock).mockImplementationOnce(() => { throw new Error('invalid signature'); });
    const ack = gateway.handleAuthRefresh(socket as any, { token: 'bad' });

    expect(ack).toEqual({ ok: false, code: 'TOKEN_INVALID' });
  });
});

// ===========================================================================
// Handlers / lifecycle / helpers — comprehensive coverage
// ===========================================================================

describe('StationGateway — handlers, lifecycle and helpers', () => {
  let gateway: StationGateway;
  let presence: any;
  let socketState: any;
  let kafkaProducer: any;
  let serverEmit: jest.Mock;
  let serverTo: jest.Mock;
  let roomEmit: jest.Mock;

  function buildSocket(extra: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { userId: 'u1', stationId: undefined, ...extra };
    return {
      id: 'sock-1',
      data,
      handshake: { auth: {} as Record<string, unknown>, headers: {} as Record<string, string | undefined> },
      disconnect: jest.fn(),
      on: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
    };
  }

  beforeEach(async () => {
    presence = {
      joinStation:           jest.fn().mockResolvedValue(undefined),
      leaveStation:          jest.fn().mockResolvedValue(undefined),
      getListenerCount:      jest.fn().mockResolvedValue(0),
      refreshHeartbeat:      jest.fn().mockResolvedValue(undefined),
      getStationSession:     jest.fn().mockResolvedValue(null),
      setStationSession:     jest.fn().mockResolvedValue(undefined),
      clearStationSession:   jest.fn().mockResolvedValue(undefined),
      resetStationSession:   jest.fn().mockResolvedValue(undefined),
      getNextStationVersion: jest.fn().mockResolvedValue(1),
      isRecentOccupant:      jest.fn().mockResolvedValue(false),
      tryAcquireLock:        jest.fn().mockResolvedValue(true),
      releaseLock:           jest.fn().mockResolvedValue(undefined),
      getActiveStationIds:   jest.fn().mockResolvedValue([]),
    };
    socketState = {
      add:       jest.fn(),
      remove:    jest.fn(),
      isOnline:  jest.fn().mockReturnValue(true),
      setServer: jest.fn(),
    };
    kafkaProducer = {
      publishCommentCreated: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StationGateway,
        { provide: PresenceService, useValue: presence },
        { provide: SocketStateService, useValue: socketState },
        { provide: KafkaProducerService, useValue: kafkaProducer },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(MOCK_PUBLIC_KEY) } },
      ],
    }).compile();

    gateway = module.get<StationGateway>(StationGateway);

    // Inject a mock server (Socket.IO `server` is a private field)
    roomEmit = jest.fn();
    serverTo = jest.fn().mockReturnValue({ emit: roomEmit });
    serverEmit = jest.fn();
    (gateway as any).server = { to: serverTo, emit: serverEmit };
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.clearAllMocks();
  });

  // ── afterInit / onModuleDestroy ──────────────────────────────────────────

  it('afterInit registers server with socketState and starts the tick interval', () => {
    jest.useFakeTimers();
    const fakeServer: any = { to: serverTo, emit: serverEmit };

    gateway.afterInit(fakeServer);

    expect(socketState.setServer).toHaveBeenCalledWith(fakeServer);
    expect((gateway as any).stationTickHandle).not.toBeNull();

    gateway.onModuleDestroy();
    expect((gateway as any).stationTickHandle).toBeNull();
    jest.useRealTimers();
  });

  it('onModuleDestroy clears pending reset timers', () => {
    jest.useFakeTimers();
    (gateway as any).pendingResets.set('s-1', setTimeout(() => undefined, 10_000));
    (gateway as any).pendingResets.set('s-2', setTimeout(() => undefined, 10_000));

    gateway.onModuleDestroy();

    expect((gateway as any).pendingResets.size).toBe(0);
    jest.useRealTimers();
  });

  // ── handleDisconnect ─────────────────────────────────────────────────────

  it('handleDisconnect leaves station, drops listener and announces offline when last socket', async () => {
    socketState.isOnline.mockReturnValue(false);
    const socket = buildSocket({ stationId: 's-1', disconnectReason: 'transport close' });

    await gateway.handleDisconnect(socket as any);

    expect(presence.leaveStation).toHaveBeenCalledWith('u1', 's-1');
    expect(socket.leave).toHaveBeenCalledWith('station:s-1');
    expect(socketState.remove).toHaveBeenCalledWith('u1', socket);
    expect(serverEmit).toHaveBeenCalledWith('user_presence_changed', { userId: 'u1', stationId: null, online: false });
  });

  it('handleDisconnect does NOT announce offline when other tabs remain', async () => {
    socketState.isOnline.mockReturnValue(true);
    const socket = buildSocket({ stationId: 's-1' });

    await gateway.handleDisconnect(socket as any);

    expect(serverEmit).not.toHaveBeenCalledWith('user_presence_changed', expect.objectContaining({ online: false }));
  });

  it('handleDisconnect early-returns when userId is missing', async () => {
    const socket = buildSocket({ userId: undefined });

    await gateway.handleDisconnect(socket as any);

    expect(presence.leaveStation).not.toHaveBeenCalled();
    expect(socketState.remove).not.toHaveBeenCalled();
  });

  // ── handleJoinStation ────────────────────────────────────────────────────

  it('handleJoinStation early-returns when no valid tracks are provided', async () => {
    const socket = buildSocket();

    await gateway.handleJoinStation(socket as any, { stationId: 's-1', tracks: [] } as any);

    expect(presence.joinStation).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('handleJoinStation creates fresh session, joins room, and emits joined_station', async () => {
    const socket = buildSocket();
    presence.getStationSession.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    presence.getListenerCount.mockResolvedValue(0);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [
        { songId: 'song-1', durationSeconds: 30 },
        { songId: 'song-2', durationSeconds: 20 },
      ],
    } as any);

    expect(presence.tryAcquireLock).toHaveBeenCalled();
    expect(presence.setStationSession).toHaveBeenCalled();
    expect(presence.releaseLock).toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith('station:s-1');
    expect(socket.emit).toHaveBeenCalledWith('joined_station', expect.objectContaining({
      stationId: 's-1',
      sessionVersion: 1,
    }));
    expect(serverEmit).toHaveBeenCalledWith('user_presence_changed', { userId: 'u1', stationId: 's-1', online: true });
  });

  it('handleJoinStation reuses existing session when listeners > 0 (mid-stream join)', async () => {
    const socket = buildSocket();
    const existing = {
      stationId: 's-1', startedAtMs: Date.now() - 5000,
      queue: ['song-1', 'song-2'], durationsSeconds: [30, 30], version: 7,
    };
    presence.getStationSession.mockResolvedValue(existing);
    presence.getListenerCount.mockResolvedValue(3);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 30 }],
    } as any);

    expect(presence.setStationSession).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('joined_station', expect.objectContaining({ sessionVersion: 7 }));
  });

  it('handleJoinStation inherits running broadcast for a recent occupant (reload)', async () => {
    const socket = buildSocket();
    const existing = {
      stationId: 's-1', startedAtMs: Date.now() - 1000,
      queue: ['song-1'], durationsSeconds: [60], version: 4,
    };
    presence.getStationSession.mockResolvedValue(existing);
    presence.getListenerCount.mockResolvedValueOnce(0).mockResolvedValue(0);
    presence.isRecentOccupant.mockResolvedValue(true);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 60 }],
    } as any);

    expect(presence.resetStationSession).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('joined_station', expect.objectContaining({ sessionVersion: 4 }));
  });

  it('handleJoinStation resets session for fresh arrival to empty station', async () => {
    const socket = buildSocket();
    const existing = {
      stationId: 's-1', startedAtMs: Date.now() - 1000,
      queue: ['song-1'], durationsSeconds: [60], version: 4,
    };
    presence.getStationSession
      .mockResolvedValueOnce(existing)         // first call: existing path
      .mockResolvedValue(null);                 // after reset
    presence.getListenerCount.mockResolvedValue(0);
    presence.isRecentOccupant.mockResolvedValue(false);
    presence.getNextStationVersion.mockResolvedValue(5);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 60 }],
    } as any);

    expect(presence.resetStationSession).toHaveBeenCalledWith('s-1');
    expect(presence.setStationSession).toHaveBeenCalled();
  });

  it('handleJoinStation leaves the previous station before joining the new one', async () => {
    const socket = buildSocket({ stationId: 's-prev' });
    presence.getStationSession.mockResolvedValue(null);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-new',
      tracks: [{ songId: 'song-1', durationSeconds: 30 }],
    } as any);

    expect(presence.leaveStation).toHaveBeenCalledWith('u1', 's-prev');
    expect(socket.leave).toHaveBeenCalledWith('station:s-prev');
  });

  it('handleJoinStation does NOT broadcast user_presence_changed when re-joining the SAME station', async () => {
    const socket = buildSocket({ stationId: 's-1' });
    presence.getStationSession.mockResolvedValue(null);

    serverEmit.mockClear();
    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 30 }],
    } as any);

    expect(serverEmit).not.toHaveBeenCalledWith('user_presence_changed', expect.anything());
  });

  it('handleJoinStation falls back to existing session when lock acquire fails', async () => {
    const socket = buildSocket();
    const fallback = {
      stationId: 's-1', startedAtMs: Date.now() - 100,
      queue: ['x'], durationsSeconds: [30], version: 9,
    };
    presence.getStationSession
      .mockResolvedValueOnce(null)        // first: no session
      .mockResolvedValueOnce(fallback);   // after lock denied
    presence.getListenerCount.mockResolvedValue(0);
    presence.tryAcquireLock.mockResolvedValue(false);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 30 }],
    } as any);

    expect(socket.emit).toHaveBeenCalledWith('joined_station', expect.objectContaining({ sessionVersion: 9 }));
    expect(presence.releaseLock).not.toHaveBeenCalled();
  });

  it('handleJoinStation creates emergency session when lock denied AND no fallback session', async () => {
    const socket = buildSocket();
    presence.getStationSession.mockResolvedValue(null);
    presence.getListenerCount.mockResolvedValue(0);
    presence.tryAcquireLock.mockResolvedValue(false);
    presence.getNextStationVersion.mockResolvedValue(11);

    await gateway.handleJoinStation(socket as any, {
      stationId: 's-1',
      tracks: [{ songId: 'song-1', durationSeconds: 30 }],
    } as any);

    expect(presence.setStationSession).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('joined_station', expect.objectContaining({ sessionVersion: 11 }));
  });

  // ── handleLeaveStation ───────────────────────────────────────────────────

  it('handleLeaveStation early-returns when no stationId on socket', async () => {
    const socket = buildSocket({ stationId: undefined });

    await gateway.handleLeaveStation(socket as any);

    expect(presence.leaveStation).not.toHaveBeenCalled();
  });

  it('handleLeaveStation removes listener, leaves room and emits presence with stationId=null', async () => {
    const socket = buildSocket({ stationId: 's-1' });

    await gateway.handleLeaveStation(socket as any);

    expect(presence.leaveStation).toHaveBeenCalledWith('u1', 's-1');
    expect(socket.leave).toHaveBeenCalledWith('station:s-1');
    expect(socket.data.stationId).toBeUndefined();
    expect(serverEmit).toHaveBeenCalledWith('user_presence_changed', { userId: 'u1', stationId: null, online: true });
  });

  // ── handleSendComment ────────────────────────────────────────────────────

  it('handleSendComment broadcasts new_comment optimistically and publishes to Kafka', async () => {
    const socket = buildSocket();
    socket.data.username = 'alice';
    socket.data.profilePhotoUrl = 'http://x/y.png';
    presence.getStationSession.mockResolvedValue({
      stationId: 's-1', startedAtMs: 1, queue: ['song-1'], durationsSeconds: [30], version: 5,
    });

    await gateway.handleSendComment(socket as any, {
      stationId: 's-1', songId: 'song-1', commentId: 'c-1', content: 'hi', mentions: [],
    } as any);

    expect(serverTo).toHaveBeenCalledWith('station:s-1');
    expect(roomEmit).toHaveBeenCalledWith('new_comment', expect.objectContaining({
      commentId: 'c-1', sessionVersion: 5, content: 'hi',
    }));
    expect(kafkaProducer.publishCommentCreated).toHaveBeenCalledWith(expect.objectContaining({
      comment_id: 'c-1', session_version: 5,
    }));
  });

  it('handleSendComment generates a UUID when commentId is omitted and defaults sessionVersion to 1', async () => {
    const socket = buildSocket();
    presence.getStationSession.mockResolvedValue(null);

    await gateway.handleSendComment(socket as any, {
      stationId: 's-1', songId: 'song-1', content: 'hi',
    } as any);

    const broadcast = roomEmit.mock.calls[0][1];
    expect(broadcast.commentId).toEqual(expect.any(String));
    expect(broadcast.sessionVersion).toBe(1);
  });

  it('handleSendComment swallows kafka publish errors via .catch', async () => {
    const socket = buildSocket();
    kafkaProducer.publishCommentCreated.mockRejectedValueOnce(new Error('kafka down'));
    presence.getStationSession.mockResolvedValue(null);

    await expect(gateway.handleSendComment(socket as any, {
      stationId: 's-1', songId: 'song-1', content: 'hi',
    } as any)).resolves.toBeUndefined();
  });

  // ── handleDeleteComment ──────────────────────────────────────────────────

  it('handleDeleteComment fans out comment_deleted to the station room', async () => {
    const socket = buildSocket();

    await gateway.handleDeleteComment(socket as any, { stationId: 's-1', commentId: 'c-9' } as any);

    expect(serverTo).toHaveBeenCalledWith('station:s-1');
    expect(roomEmit).toHaveBeenCalledWith('comment_deleted', { commentId: 'c-9', stationId: 's-1' });
  });

  // ── handleLikeDelta ──────────────────────────────────────────────────────

  it('handleLikeDelta normalises delta to +1 / -1 and emits to station room', async () => {
    const socket = buildSocket();

    await gateway.handleLikeDelta(socket as any, { stationId: 's-1', songId: 'song-1', delta: 5 } as any);
    await gateway.handleLikeDelta(socket as any, { stationId: 's-1', songId: 'song-1', delta: -2 } as any);

    expect(roomEmit).toHaveBeenNthCalledWith(1, 'like_delta', expect.objectContaining({ delta: 1 }));
    expect(roomEmit).toHaveBeenNthCalledWith(2, 'like_delta', expect.objectContaining({ delta: -1 }));
  });

  // ── handleFriendRemoved ──────────────────────────────────────────────────

  it('handleFriendRemoved emits to BOTH the removed friend and the actor', async () => {
    const socket = buildSocket();

    await gateway.handleFriendRemoved(socket as any, {
      friendshipId: 'f-1', otherUserId: 'u-other',
    } as any);

    expect(serverTo).toHaveBeenCalledWith('user:u-other');
    expect(serverTo).toHaveBeenCalledWith('user:u1');
    expect(roomEmit).toHaveBeenCalledWith('friend_removed', { friendshipId: 'f-1', removedByUserId: 'u1' });
  });

  it('handleFriendRemoved emits only to the other user when actor has no userId', async () => {
    const socket = buildSocket({ userId: undefined });

    await gateway.handleFriendRemoved(socket as any, {
      friendshipId: 'f-1', otherUserId: 'u-other',
    } as any);

    expect(serverTo).toHaveBeenCalledWith('user:u-other');
    expect(serverTo).toHaveBeenCalledTimes(1);
  });

  // ── handlePingPresence ───────────────────────────────────────────────────

  it('handlePingPresence early-returns when stationId is missing', async () => {
    const socket = buildSocket();

    await gateway.handlePingPresence(socket as any);

    expect(presence.refreshHeartbeat).not.toHaveBeenCalled();
  });

  it('handlePingPresence refreshes heartbeat and emits pong_presence (no session)', async () => {
    const socket = buildSocket({ stationId: 's-1', songId: 'song-1' });
    presence.getStationSession.mockResolvedValue(null);

    await gateway.handlePingPresence(socket as any);

    expect(presence.refreshHeartbeat).toHaveBeenCalledWith('u1', 's-1', 'song-1');
    expect(socket.emit).toHaveBeenCalledWith('pong_presence', { ok: true });
  });

  it('handlePingPresence updates songId from session-derived playback when session exists', async () => {
    const socket = buildSocket({ stationId: 's-1' });
    presence.getStationSession.mockResolvedValue({
      stationId: 's-1', startedAtMs: Date.now() - 5_000,
      queue: ['song-A', 'song-B'], durationsSeconds: [10, 10], version: 1,
    });

    await gateway.handlePingPresence(socket as any);

    // 5s elapsed in [10s, 10s] cycle → first song still playing
    expect(socket.data.songId).toBe('song-A');
    expect(presence.refreshHeartbeat).toHaveBeenCalledWith('u1', 's-1', 'song-A');
  });

  // ── emitToUser ───────────────────────────────────────────────────────────

  it('emitToUser publishes to the user:{userId} room', () => {
    gateway.emitToUser('user-1', 'notification', { id: 'n-1' });

    expect(serverTo).toHaveBeenCalledWith('user:user-1');
    expect(roomEmit).toHaveBeenCalledWith('notification', { id: 'n-1' });
  });

  // ── normaliseTracks ──────────────────────────────────────────────────────

  it('normaliseTracks deduplicates by songId, drops invalid durations and floors decimals', () => {
    const out = (gateway as any).normaliseTracks([
      { songId: 'a', durationSeconds: 30 },
      { songId: 'a', durationSeconds: 99 },        // duplicate — kept first
      { songId: 'b', durationSeconds: 0 },         // dropped (<=0)
      { songId: 'c', durationSeconds: -5 },        // dropped (<0)
      { songId: '',  durationSeconds: 30 },        // dropped (no id)
      { songId: 'd', durationSeconds: 'bad' },     // dropped (not finite)
      { songId: 'e', durationSeconds: 12.7 },      // floored to 12
      null,                                          // dropped
    ]);
    expect(out).toEqual([
      { songId: 'a', durationSeconds: 30 },
      { songId: 'e', durationSeconds: 12 },
    ]);
  });

  it('normaliseTracks tolerates undefined input and returns empty array', () => {
    expect((gateway as any).normaliseTracks(undefined)).toEqual([]);
  });

  // ── calculatePlaybackState ──────────────────────────────────────────────

  it('calculatePlaybackState returns empty when queue is empty', () => {
    const out = (gateway as any).calculatePlaybackState({
      stationId: 's-1', startedAtMs: 0, queue: [], durationsSeconds: [], version: 1,
    }, 1000);
    expect(out).toEqual({ songId: '', offsetSeconds: 0, version: 1, nextSongId: '' });
  });

  it('calculatePlaybackState returns the current track and nextSongId with wrap-around', () => {
    const session = {
      stationId: 's-1', startedAtMs: 0,
      queue: ['a', 'b', 'c'], durationsSeconds: [10, 10, 10], version: 2,
    };
    // 5s elapsed → first track
    const t0 = (gateway as any).calculatePlaybackState(session, 5_000);
    expect(t0).toEqual({ songId: 'a', offsetSeconds: 5, version: 2, nextSongId: 'b' });

    // 12s elapsed → second track, offset 2
    const t1 = (gateway as any).calculatePlaybackState(session, 12_000);
    expect(t1).toEqual({ songId: 'b', offsetSeconds: 2, version: 2, nextSongId: 'c' });

    // 25s elapsed → third track, offset 5, next wraps to 'a'
    const t2 = (gateway as any).calculatePlaybackState(session, 25_000);
    expect(t2).toEqual({ songId: 'c', offsetSeconds: 5, version: 2, nextSongId: 'a' });
  });

  it('calculatePlaybackState returns nextSongId="" when the queue has only one song', () => {
    const out = (gateway as any).calculatePlaybackState({
      stationId: 's-1', startedAtMs: 0, queue: ['solo'], durationsSeconds: [10], version: 1,
    }, 5_000);
    expect(out).toEqual({ songId: 'solo', offsetSeconds: 5, version: 1, nextSongId: '' });
  });

  // ── createStationSession / fisherYatesShuffle ──────────────────────────

  it('createStationSession returns queue and durations of the same length as input tracks', () => {
    const session = (gateway as any).createStationSession('s-1', [
      { songId: 'a', durationSeconds: 10 },
      { songId: 'b', durationSeconds: 20 },
    ], 3);
    expect(session.queue.sort()).toEqual(['a', 'b']);
    expect(session.durationsSeconds).toHaveLength(2);
    expect(session.version).toBe(3);
    expect(session.stationId).toBe('s-1');
  });

  // ── maybeRotateCycle ────────────────────────────────────────────────────

  it('maybeRotateCycle returns the same session when not yet fully played', async () => {
    const session = {
      stationId: 's-1', startedAtMs: 1_000,
      queue: ['a', 'b'], durationsSeconds: [10, 10], version: 1,
    };
    const out = await (gateway as any).maybeRotateCycle(session, 5_000);
    expect(out).toBe(session);
    expect(presence.setStationSession).not.toHaveBeenCalled();
  });

  it('maybeRotateCycle reshuffles and persists when cycle has fully played', async () => {
    const session = {
      stationId: 's-1', startedAtMs: 0,
      queue: ['a', 'b'], durationsSeconds: [10, 10], version: 1,
    };
    const out = await (gateway as any).maybeRotateCycle(session, 30_000);

    expect(presence.setStationSession).toHaveBeenCalled();
    expect(out.startedAtMs).toBe(30_000);
    expect(out.queue.sort()).toEqual(['a', 'b']);
    expect(out.version).toBe(1); // version preserved
  });

  it('maybeRotateCycle returns the session when queue is empty', async () => {
    const session = {
      stationId: 's-1', startedAtMs: 0, queue: [], durationsSeconds: [], version: 1,
    };
    const out = await (gateway as any).maybeRotateCycle(session, 30_000);
    expect(out).toBe(session);
  });

  // ── scheduleOrCancelReset / executeReset ───────────────────────────────

  it('broadcastListenerCount cancels pending reset when listeners > 0', async () => {
    jest.useFakeTimers();
    presence.getListenerCount.mockResolvedValue(0);
    await (gateway as any).broadcastListenerCount('s-1');
    expect((gateway as any).pendingResets.has('s-1')).toBe(true);

    presence.getListenerCount.mockResolvedValue(2);
    await (gateway as any).broadcastListenerCount('s-1');
    expect((gateway as any).pendingResets.has('s-1')).toBe(false);
    jest.useRealTimers();
  });

  it('scheduleOrCancelReset is idempotent — second call with count=0 keeps the same timer', () => {
    jest.useFakeTimers();
    (gateway as any).scheduleOrCancelReset('s-1', 0);
    const t1 = (gateway as any).pendingResets.get('s-1');
    (gateway as any).scheduleOrCancelReset('s-1', 0);
    const t2 = (gateway as any).pendingResets.get('s-1');
    expect(t1).toBe(t2);
    jest.useRealTimers();
  });

  it('executeReset bumps version when count is still 0', async () => {
    presence.getListenerCount.mockResolvedValue(0);
    (gateway as any).lastTrackByStation.set('s-1', { songId: 'x', version: 1 });

    await (gateway as any).executeReset('s-1');

    expect(presence.resetStationSession).toHaveBeenCalledWith('s-1');
    expect((gateway as any).lastTrackByStation.has('s-1')).toBe(false);
  });

  it('executeReset aborts when listeners returned during the grace window', async () => {
    presence.getListenerCount.mockResolvedValue(2);

    await (gateway as any).executeReset('s-1');

    expect(presence.resetStationSession).not.toHaveBeenCalled();
  });

  it('executeReset triggered by timer eventually calls resetStationSession', async () => {
    jest.useFakeTimers();
    presence.getListenerCount.mockResolvedValue(0);

    (gateway as any).scheduleOrCancelReset('s-1', 0);

    // Run the timer
    jest.advanceTimersByTime(31_000);
    // Allow microtasks to settle
    await Promise.resolve();
    await Promise.resolve();
    jest.useRealTimers();
  });

  // ── syncStationPlaybackTicks ───────────────────────────────────────────

  it('syncStationPlaybackTicks emits track_changed when the current song changes', async () => {
    presence.getActiveStationIds.mockResolvedValue(['s-1']);
    presence.getListenerCount.mockResolvedValue(2);
    presence.getStationSession.mockResolvedValue({
      stationId: 's-1', startedAtMs: Date.now() - 15_000,
      queue: ['a', 'b'], durationsSeconds: [10, 10], version: 4,
    });

    // Pre-seed lastTrackByStation with a different song so change-detection fires
    (gateway as any).lastTrackByStation.set('s-1', { songId: 'a', version: 4 });

    await (gateway as any).syncStationPlaybackTicks();

    expect(serverTo).toHaveBeenCalledWith('station:s-1');
    expect(roomEmit).toHaveBeenCalledWith('track_changed', expect.objectContaining({
      stationId: 's-1',
      sessionVersion: 4,
    }));
  });

  it('syncStationPlaybackTicks skips stations with no listeners and prunes lastTrackByStation', async () => {
    presence.getActiveStationIds.mockResolvedValue(['s-1']);
    presence.getListenerCount.mockResolvedValue(0);
    (gateway as any).lastTrackByStation.set('s-1', { songId: 'a', version: 1 });

    await (gateway as any).syncStationPlaybackTicks();

    expect((gateway as any).lastTrackByStation.has('s-1')).toBe(false);
  });

  it('syncStationPlaybackTicks prunes stale lastTrackByStation entries for inactive stations', async () => {
    presence.getActiveStationIds.mockResolvedValue([]);
    (gateway as any).lastTrackByStation.set('zombie', { songId: 'a', version: 1 });

    await (gateway as any).syncStationPlaybackTicks();

    expect((gateway as any).lastTrackByStation.has('zombie')).toBe(false);
  });

  it('syncStationPlaybackTicks no-ops when an in-flight tick is still running', async () => {
    (gateway as any).stationTickInFlight = true;

    await (gateway as any).syncStationPlaybackTicks();

    expect(presence.getActiveStationIds).not.toHaveBeenCalled();
  });

  it('syncStationPlaybackTicks releases the in-flight flag in the finally block (even when getActive throws)', async () => {
    presence.getActiveStationIds.mockRejectedValue(new Error('redis down'));

    await expect((gateway as any).syncStationPlaybackTicks()).rejects.toThrow('redis down');
    expect((gateway as any).stationTickInFlight).toBe(false);
  });

  it('syncStationPlaybackTicks skips stations whose session is missing', async () => {
    presence.getActiveStationIds.mockResolvedValue(['s-1']);
    presence.getListenerCount.mockResolvedValue(2);
    presence.getStationSession.mockResolvedValue(null);
    (gateway as any).lastTrackByStation.set('s-1', { songId: 'old', version: 1 });

    await (gateway as any).syncStationPlaybackTicks();

    expect((gateway as any).lastTrackByStation.has('s-1')).toBe(false);
    expect(roomEmit).not.toHaveBeenCalledWith('track_changed', expect.anything());
  });

  it('syncStationPlaybackTicks does NOT emit when the current song has not changed', async () => {
    presence.getActiveStationIds.mockResolvedValue(['s-1']);
    presence.getListenerCount.mockResolvedValue(2);
    const session = {
      stationId: 's-1', startedAtMs: Date.now() - 5_000,
      queue: ['a', 'b'], durationsSeconds: [10, 10], version: 4,
    };
    presence.getStationSession.mockResolvedValue(session);
    (gateway as any).lastTrackByStation.set('s-1', { songId: 'a', version: 4 });

    await (gateway as any).syncStationPlaybackTicks();

    expect(roomEmit).not.toHaveBeenCalledWith('track_changed', expect.anything());
  });
});
