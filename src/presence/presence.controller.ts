import { Controller, Get, Headers, Param } from '@nestjs/common';
import { PresenceService } from './presence.service';

@Controller('presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get('me')
  async getMyPresence(@Headers('x-user-id') userId: string) {
    const data = await this.presence.getPresence(userId);
    return { online: !!data, ...(data ?? {}) };
  }

  @Get('users/:userId')
  async getUserPresence(@Param('userId') userId: string) {
    const data = await this.presence.getPresence(userId);
    return { online: !!data, ...(data ?? {}) };
  }

  @Get('stations/:stationId/listeners')
  async getStationListeners(@Param('stationId') stationId: string) {
    const [count, listeners] = await Promise.all([
      this.presence.getListenerCount(stationId),
      this.presence.getListeners(stationId),
    ]);
    return { stationId, count, listeners };
  }
}
