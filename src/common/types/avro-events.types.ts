/**
 * @generated — TypeScript interfaces derived from Avro schemas in avro/schemas/.
 * Do NOT edit manually. Regenerate by running: npm run generate:asyncapi
 *
 * Avro contract: avro/schemas/realtime.*.avsc
 * AsyncAPI contract: asyncapi.yml
 */

// ── Kafka Topics ─────────────────────────────────────────────────────────────

export const TOPICS = {
  COMMENT_CREATED:    'realtime.comment.created',
  COMMENT_LIKED:      'realtime.comment.liked',
  NOTIFICATION_PUSH:  'realtime.notification.push',
  CHAT_MESSAGE:       'realtime.chat.message',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

// ── Avro Events (Kafka payloads) ──────────────────────────────────────────────

/** realtime.comment.created — produced by ws-ms, consumed by api-ms */
export interface CommentCreatedEvent {
  comment_id:        string;           // client-generated UUID (idempotency key)
  song_id:           string;
  station_id:        string;
  user_id:           string;
  username:          string;
  profile_photo_url: string | null;
  content:           string;
  mentions:          string[];
  timestamp:         number;           // epoch millis
}

/** realtime.comment.liked — produced by ws-ms, consumed by api-ms */
export interface CommentLikedEvent {
  comment_id:        string;
  comment_author_id: string;
  liker_id:          string;
  liker_username:    string;
  liker_photo_url:   string | null;
  song_id:           string;
  station_id:        string;
  timestamp:         number;
  /** Explicit discriminator: 'like' | 'unlike'. Replaces the UNLIKE: prefix hack. */
  action:            'like' | 'unlike';
}

/** realtime.notification.push — produced by api-ms, consumed by ws-ms */
export interface NotificationPushEvent {
  notification_id: string;
  recipient_id:    string;
  actor_id:        string;
  actor_username:  string;
  actor_photo_url: string | null;
  type:            NotificationEventType;
  target_id:       string;
  target_type:     string;
  timestamp:       number;
}

export enum NotificationEventType {
  COMMENT_REACTION = 'COMMENT_REACTION',
  MENTION          = 'MENTION',
  FRIEND_REQUEST   = 'FRIEND_REQUEST',
  FRIEND_ACCEPTED  = 'FRIEND_ACCEPTED',
}

// ── JSON Events (from Spring Boot services — no Avro) ─────────────────────────

export interface FriendRequestEvent {
  requesterId:        string;
  addresseeId:        string;
  friendshipId:       string;
  requesterUsername:  string;
  requesterPhotoUrl:  string | null;
}

export interface FriendAcceptedEvent {
  requesterId:       string;
  addresseeId:       string;
  friendshipId:      string;
  addresseeUsername: string;
  addresseePhotoUrl: string | null;
}

// ── WebSocket Event DTOs (from AsyncAPI channels) ─────────────────────────────

/** Server → Client: new_comment broadcast */
export interface WsCommentPayload {
  commentId:       string;
  songId:          string;
  stationId:       string;
  userId:          string;
  username:        string;
  profilePhotoUrl: string | null;
  content:         string;
  mentions:        string[];
  likesCount:      number;
  createdAt:       string;
}

/** Server → Client: notification push */
export interface WsNotificationPayload {
  notificationId: string;
  actorId:        string;
  actorUsername:  string;
  actorPhotoUrl:  string | null;
  type:           NotificationEventType;
  targetId:       string;
  targetType:     string;
  createdAt:      string;
}

/** Server → Client: listener_count */
export interface WsListenerCountPayload {
  stationId: string;
  count:     number;
}

// ── Chat Events ───────────────────────────────────────────────────────────────

/** realtime.chat.message — produced by ws-ms, consumed by api-ms for persistence */
export interface ChatMessageEvent {
  message_id:        string;
  station_id:        string;
  user_id:           string;
  username:          string;
  profile_photo_url: string | null;
  content:           string;
  mentions:          string[];
  timestamp:         string;  // ISO-8601
}

/** Client → Server: send_chat_message payload */
export interface WsSendChatMessagePayload {
  stationId: string;
  content:   string;
  mentions?: string[];
}

/** Server → Client: new_chat_message broadcast */
export interface WsChatMessagePayload {
  messageId:       string;
  stationId:       string;
  userId:          string;
  username:        string;
  profilePhotoUrl: string | null;
  content:         string;
  mentions:        string[];
  timestamp:       string;
}

/** Server → Client: comment_likes_updated broadcast (optimistic UI) */
export interface WsCommentLikesUpdatedPayload {
  commentId: string;
  action:    'like' | 'unlike';
  userId:    string;  // liker's userId
}
