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
import { SocketStateService } from '../socket/socket-state.service';
import { WsCommentLikesUpdatedPayload } from '../common/types/avro-events.types';

/** Handles comment mutations that originate from REST (e.g. like/unlike). */
@Controller('comments')
export class CommentsController {
  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly socketState: SocketStateService,
  ) {}

  /**
   * Like a comment.
   * Publishes realtime.comment.liked (Avro) to Kafka with action='like'.
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
      action:            'like',
    });

    // Optimistic UI: broadcast to station room so clients can update their counters immediately
    const likePayload: WsCommentLikesUpdatedPayload = { commentId, action: 'like', userId: likerId };
    this.socketState.emitToStation(body.stationId, 'comment_likes_updated', likePayload);

    return { accepted: true };
  }

  /**
   * Unlike a comment.
   * Publishes realtime.comment.liked (Avro) to Kafka with action='unlike'.
   * realtime-api-ms checks action === 'unlike' to distinguish from a like.
   */
  @Delete(':id/like')
  @HttpCode(HttpStatus.ACCEPTED)
  async unlikeComment(
    @Param('id') commentId: string,
    @Body() body: { commentAuthorId: string; songId: string; stationId: string },
    @Headers('x-user-id') likerId: string,
    @Headers('x-display-name') likerUsername: string,
  ) {
    await this.kafkaProducer.publishCommentLiked({
      comment_id:        commentId,
      comment_author_id: body.commentAuthorId,
      liker_id:          likerId,
      liker_username:    likerUsername ?? likerId,
      liker_photo_url:   null,
      song_id:           body.songId,
      station_id:        body.stationId,
      timestamp:         Date.now(),
      action:            'unlike',
    });

    // Optimistic UI: broadcast unlike to station room
    const unlikePayload: WsCommentLikesUpdatedPayload = { commentId, action: 'unlike', userId: likerId };
    this.socketState.emitToStation(body.stationId, 'comment_likes_updated', unlikePayload);

    return { accepted: true };
  }
}
