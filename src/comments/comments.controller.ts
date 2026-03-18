import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { KafkaProducerService } from '../kafka/kafka.producer';

/** Handles comment mutations that originate from REST (e.g. like/unlike). */
@Controller('comments')
export class CommentsController {
  constructor(private readonly kafkaProducer: KafkaProducerService) {}

  /**
   * Like a comment.
   * Publishes realtime.comment.liked (Avro) to Kafka.
   * realtime-api-ms handles persistence + COMMENT_REACTION notification.
   */
  @Post(':id/like')
  @HttpCode(HttpStatus.ACCEPTED)
  async likeComment(
    @Param('id') commentId: string,
    @Body() body: { commentAuthorId: string; songId: string; stationId: string },
    @Headers('x-user-id') likerId: string,
    @Headers('x-display-name') likerUsername: string,
    @Headers('x-profile-photo-url') likerPhotoUrl: string,
  ) {
    await this.kafkaProducer.publishCommentLiked({
      comment_id:        commentId,
      comment_author_id: body.commentAuthorId,
      liker_id:          likerId,
      liker_username:    likerUsername ?? likerId,
      liker_photo_url:   likerPhotoUrl ?? null,
      song_id:           body.songId,
      station_id:        body.stationId,
      timestamp:         Date.now(),
    });
    return { accepted: true };
  }

  /**
   * Unlike a comment.
   * Publishes a partial comment.liked event with a special "unlike" flag.
   * In this architecture, unlike is handled as a compensating event in api-ms.
   */
  @Delete(':id/like')
  @HttpCode(HttpStatus.ACCEPTED)
  async unlikeComment(
    @Param('id') commentId: string,
    @Body() body: { commentAuthorId: string; songId: string; stationId: string },
    @Headers('x-user-id') likerId: string,
    @Headers('x-display-name') likerUsername: string,
  ) {
    // Unlike uses the same topic with liker_username prefixed with UNLIKE:
    // realtime-api-ms distinguishes via this convention.
    await this.kafkaProducer.publishCommentLiked({
      comment_id:        commentId,
      comment_author_id: body.commentAuthorId,
      liker_id:          likerId,
      liker_username:    `UNLIKE:${likerUsername ?? likerId}`,
      liker_photo_url:   null,
      song_id:           body.songId,
      station_id:        body.stationId,
      timestamp:         Date.now(),
    });
    return { accepted: true };
  }
}
