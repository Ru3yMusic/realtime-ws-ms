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
});
