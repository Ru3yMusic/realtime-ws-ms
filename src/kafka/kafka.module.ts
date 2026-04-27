import { Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka.producer';
import { KafkaConsumerService } from './kafka.consumer';
import { CatalogStatsConsumerService } from './catalog-stats.consumer';
import { MusicFeedConsumerService } from './music-feed.consumer';

@Module({
  providers: [
    KafkaProducerService,
    KafkaConsumerService,
    CatalogStatsConsumerService,
    MusicFeedConsumerService,
  ],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
