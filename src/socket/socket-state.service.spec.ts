import { SocketStateService } from './socket-state.service';
import { Server, Socket } from 'socket.io';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocket(id = 'sock-1'): jest.Mocked<Pick<Socket, 'id' | 'emit'>> {
  return { id, emit: jest.fn() } as any;
}

function makeServer(): { to: jest.Mock; emit: jest.Mock } {
  const roomChain = { emit: jest.fn() };
  return { to: jest.fn().mockReturnValue(roomChain), emit: jest.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SocketStateService', () => {
  let service: SocketStateService;

  beforeEach(() => {
    service = new SocketStateService();
  });

  // ── add / remove / isOnline ───────────────────────────────────────────────

  it('tracks a socket after add()', () => {
    const socket = makeSocket();
    service.add('user-1', socket as any);
    expect(service.isOnline('user-1')).toBe(true);
  });

  it('removes a socket after remove()', () => {
    const socket = makeSocket();
    service.add('user-1', socket as any);
    service.remove('user-1', socket as any);
    expect(service.isOnline('user-1')).toBe(false);
  });

  it('stays online when one of two sockets is removed', () => {
    const s1 = makeSocket('s1');
    const s2 = makeSocket('s2');
    service.add('user-1', s1 as any);
    service.add('user-1', s2 as any);
    service.remove('user-1', s1 as any);
    expect(service.isOnline('user-1')).toBe(true);
  });

  it('isOnline returns false for unknown user', () => {
    expect(service.isOnline('ghost')).toBe(false);
  });

  // ── emit — fallback (no server) ───────────────────────────────────────────

  it('falls back to local socket emit when server is not set', () => {
    const socket = makeSocket();
    service.add('user-1', socket as any);

    service.emit('user-1', 'notification', { msg: 'hello' });

    expect(socket.emit).toHaveBeenCalledWith('notification', { msg: 'hello' });
  });

  it('no-op fallback emit for unknown user without server', () => {
    // Should not throw
    expect(() => service.emit('ghost', 'notification', {})).not.toThrow();
  });

  // ── emit — room-based (server set) ───────────────────────────────────────

  it('emits to room user:{userId} when server is set via setServer()', () => {
    const server = makeServer();
    service.setServer(server as unknown as Server);

    service.emit('user-42', 'notification', { id: 'n-1' });

    expect(server.to).toHaveBeenCalledWith('user:user-42');
    expect(server.to('user:user-42').emit).toHaveBeenCalledWith('notification', { id: 'n-1' });
  });

  it('does NOT call local socket emit when server is set', () => {
    const socket = makeSocket();
    service.add('user-1', socket as any);

    const server = makeServer();
    service.setServer(server as unknown as Server);

    service.emit('user-1', 'notification', {});

    // Room-based emit used instead
    expect(socket.emit).not.toHaveBeenCalled();
    expect(server.to).toHaveBeenCalledWith('user:user-1');
  });
});
