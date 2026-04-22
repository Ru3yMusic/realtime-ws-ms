import { IsUUID } from 'class-validator';

/** AsyncAPI channel: delete_comment */
export class DeleteCommentDto {
  @IsUUID()
  commentId: string;

  @IsUUID()
  stationId: string;
}
