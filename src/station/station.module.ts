import { Module } from '@nestjs/common';
import { StationCleanupService } from './station-cleanup.service';

@Module({
  providers: [StationCleanupService],
})
export class StationModule {}
