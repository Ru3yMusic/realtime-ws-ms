import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class SocketStateService {
  private readonly userSockets = new Map<string, Set<Socket>>();

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

  /** Push a typed event to all sockets belonging to a user. */
  emit(userId: string, event: string, data: unknown): void {
    this.userSockets.get(userId)?.forEach((s) => s.emit(event, data));
  }

  isOnline(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }
}
