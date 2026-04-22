import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { SocketStateService } from '../socket/socket-state.service';
import { BulkPresenceDto } from './dto/bulk-presence.dto';

@Controller('presence')
export class PresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly socketState: SocketStateService,
  ) {}

  @Get('me')
  async getMyPresence(@Headers('x-user-id') userId: string) {
    return this.buildPresenceResponse(userId);
  }

  @Get('users/:userId')
  async getUserPresence(@Param('userId') userId: string) {
    return this.buildPresenceResponse(userId);
  }

  @Get('stations/:stationId/listeners')
  async getStationListeners(@Param('stationId') stationId: string) {
    const [count, listeners] = await Promise.all([
      this.presence.getListenerCount(stationId),
      this.presence.getListeners(stationId),
    ]);
    return { stationId, count, listeners };
  }

  /**
   * Bulk presence lookup for the "Activos estación" + "Amigos" screens.
   * Body: { userIds: string[] }  (validated by BulkPresenceDto)
   * Returns: { [userId]: { online: boolean, station_id?, song_id?, last_active? } }
   *
   * `online` is true if the user has ANY active socket (global presence),
   * not only when they are listening in a station. This way the Amigos tab
   * shows "Activo" on login even before the user opens a station.
   *
   * Note on auth: this endpoint still trusts the gateway for identity (no
   * JWT validation here yet). Body validation below caps array size and
   * rejects non-UUID ids so a malicious caller can't trigger a massive
   * Redis pipeline. Full per-caller authorization is tracked separately.
   */
  @Post('users/bulk')
  async getBulkPresence(@Body() body: BulkPresenceDto) {
    const userIds = body.userIds;
    const station = await this.presence.getBulkPresence(userIds);
    const result: Record<string, { online: boolean; station_id?: string; song_id?: string; last_active?: string }> = {};
    for (const id of userIds) {
      const s = station[id] ?? { online: false };
      result[id] = {
        ...s,
        online: this.socketState.isOnline(id) || s.online,
      };
    }
    return result;
  }

  private async buildPresenceResponse(userId: string) {
    const data = await this.presence.getPresence(userId);
    const online = !!data || this.socketState.isOnline(userId);
    return data ? { online, ...data } : { online };
  }
}
