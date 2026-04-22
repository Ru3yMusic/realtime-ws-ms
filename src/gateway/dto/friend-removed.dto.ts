import { IsUUID } from 'class-validator';

/** AsyncAPI channel: friend_removed */
export class FriendRemovedDto {
  @IsUUID()
  friendshipId: string;

  @IsUUID()
  otherUserId: string;
}
