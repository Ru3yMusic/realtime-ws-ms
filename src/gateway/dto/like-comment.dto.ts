import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

/** Payload for POST /comments/:id/like */
export class LikeCommentDto {
  @IsUUID()
  commentId: string;

  @IsUUID()
  commentAuthorId: string;

  @IsUUID()
  songId: string;

  @IsUUID()
  stationId: string;
}
