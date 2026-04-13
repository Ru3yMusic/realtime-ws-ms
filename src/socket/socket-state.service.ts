import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@Injectable()
export class SocketStateService {
  /** Local socket map — used only for disconnect cleanup and isOnline checks on this instance. */
  private readonly userSockets = new Map<string, Set<Socket>>();

  /**
   * Reference to the Socket.IO server, injected by StationGateway.afterInit().
   * When set, emit() uses room-based delivery (works across instances via Redis adapter).
   */
  private server: Server | null = null;

  /** Called by StationGateway.afterInit() once the Socket.IO server is ready. */
  setServer(server: Server): void {
    this.server = server;
  }

  add(userId: string, socket: Socket): void {
    if (!this.userSockets.has(userId)) this.userSockets.set(userId, new Set());
    this.userSockets.get(userId).add(socket);
  }

  remove(userId: string, socket: Socket): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.userSockets.delete(userId);
  }

  /**
   * Push a typed event to a user.
   *
   * When the Socket.IO server reference is available (i.e. after gateway init),
   * emits to the room `user:{userId}` — this is broadcast via the Redis adapter
   * to all instances, ensuring cross-pod delivery.
   *
   * Falls back to local socket iteration if the server is not yet initialised
   * (should not happen in production).
   */
  emit(userId: string, event: string, data: unknown): void {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, data);
      return;
    }
    // Fallback: direct local socket emit (single-instance only)
    this.userSockets.get(userId)?.forEach((s) => s.emit(event, data));
  }

  /** True if this instance has at least one local socket for the user. */
  isOnline(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }

  /**
   * Push an event to all users in a station room.
   * Works across instances via the Redis adapter (room `station:{stationId}`).
   */
  emitToStation(stationId: string, event: string, data: unknown): void {
    if (this.server) {
      this.server.to(`station:${stationId}`).emit(event, data);
      return;
    }
    // Server not yet initialised — should not happen in production after gateway init
    console.warn(`SocketStateService.emitToStation: server not initialised, dropping ${event}`);
  }
}
