import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/**
 * POST /presence/users/bulk body contract.
 *
 * NOTE: this endpoint does NOT validate the caller's identity yet — full auth
 * (JWT validation + "is friend of?" check) is tracked as a separate hardening
 * task. What we do ensure here is:
 *   - body shape is `{ userIds: string[] }`
 *   - every id is a valid UUID
 *   - array size is capped so a malicious client can't trigger a massive
 *     Redis pipeline round-trip.
 *
 * Empty arrays are allowed on purpose — the previous endpoint returned `{}`
 * for an empty input and callers that happen to send no ids rely on that.
 */
export class BulkPresenceDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  userIds: string[];
}
