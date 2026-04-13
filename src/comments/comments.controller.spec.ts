import { Test, TestingModule } from '@nestjs/testing';
import { CommentsController } from './comments.controller';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { SocketStateService } from '../socket/socket-state.service';

describe('CommentsController — like / unlike', () => {
  let controller: CommentsController;
  let kafkaProducer: jest.Mocked<Pick<KafkaProducerService, 'publishCommentLiked'>>;
  let socketState: jest.Mocked<Pick<SocketStateService, 'emitToStation'>>;

  beforeEach(async () => {
    kafkaProducer = { publishCommentLiked: jest.fn().mockResolvedValue(undefined) };
    socketState   = { emitToStation: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommentsController],
      providers: [
        { provide: KafkaProducerService, useValue: kafkaProducer },
        { provide: SocketStateService,   useValue: socketState   },
      ],
    }).compile();

    controller = module.get<CommentsController>(CommentsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── likeComment ───────────────────────────────────────────────────────────

  it('publishes comment.liked with action="like"', async () => {
    await controller.likeComment(
      'comment-1',
      { commentAuthorId: 'author-1', songId: 'song-1', stationId: 'station-1' },
      'liker-99',
      'alice',
      'https://cdn.example.com/alice.jpg',
    );

    expect(kafkaProducer.publishCommentLiked).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id:        'comment-1',
        liker_id:          'liker-99',
        liker_username:    'alice',
        liker_photo_url:   'https://cdn.example.com/alice.jpg',
        action:            'like',
      }),
    );
  });

  it('broadcasts comment_likes_updated to station room with action=like', async () => {
    await controller.likeComment(
      'comment-1',
      { commentAuthorId: 'author-1', songId: 'song-1', stationId: 'station-1' },
      'liker-99',
      'alice',
      null as any,
    );

    expect(socketState.emitToStation).toHaveBeenCalledWith(
      'station-1',
      'comment_likes_updated',
      { commentId: 'comment-1', action: 'like', userId: 'liker-99' },
    );
  });

  it('falls back to likerId when likerUsername header is absent (like)', async () => {
    await controller.likeComment(
      'comment-2',
      { commentAuthorId: 'author-2', songId: 'song-2', stationId: 'station-2' },
      'liker-77',
      undefined as any,
      null as any,
    );

    expect(kafkaProducer.publishCommentLiked).toHaveBeenCalledWith(
      expect.objectContaining({ liker_username: 'liker-77', action: 'like' }),
    );
  });

  it('returns { accepted: true } on like', async () => {
    const result = await controller.likeComment(
      'comment-3',
      { commentAuthorId: 'a', songId: 's', stationId: 'st' },
      'u', 'bob', null as any,
    );
    expect(result).toEqual({ accepted: true });
  });

  // ── unlikeComment ─────────────────────────────────────────────────────────

  it('publishes comment.liked with action="unlike" and NO UNLIKE: prefix', async () => {
    await controller.unlikeComment(
      'comment-1',
      { commentAuthorId: 'author-1', songId: 'song-1', stationId: 'station-1' },
      'liker-99',
      'alice',
    );

    const call = kafkaProducer.publishCommentLiked.mock.calls[0][0];

    expect(call.action).toBe('unlike');
    expect(call.liker_username).toBe('alice');
    // Must NOT contain the UNLIKE: prefix
    expect(call.liker_username).not.toMatch(/^UNLIKE:/);
  });

  it('broadcasts comment_likes_updated to station room with action=unlike', async () => {
    await controller.unlikeComment(
      'comment-1',
      { commentAuthorId: 'author-1', songId: 'song-1', stationId: 'station-1' },
      'liker-99',
      'alice',
    );

    expect(socketState.emitToStation).toHaveBeenCalledWith(
      'station-1',
      'comment_likes_updated',
      { commentId: 'comment-1', action: 'unlike', userId: 'liker-99' },
    );
  });

  it('falls back to likerId when likerUsername header is absent (unlike)', async () => {
    await controller.unlikeComment(
      'comment-2',
      { commentAuthorId: 'author-2', songId: 'song-2', stationId: 'station-2' },
      'liker-55',
      undefined as any,
    );

    expect(kafkaProducer.publishCommentLiked).toHaveBeenCalledWith(
      expect.objectContaining({ liker_username: 'liker-55', action: 'unlike' }),
    );
  });

  it('sets liker_photo_url to null on unlike', async () => {
    await controller.unlikeComment(
      'comment-3',
      { commentAuthorId: 'a', songId: 's', stationId: 'st' },
      'u', 'bob',
    );

    expect(kafkaProducer.publishCommentLiked).toHaveBeenCalledWith(
      expect.objectContaining({ liker_photo_url: null }),
    );
  });

  it('returns { accepted: true } on unlike', async () => {
    const result = await controller.unlikeComment(
      'comment-4',
      { commentAuthorId: 'a', songId: 's', stationId: 'st' },
      'u', 'bob',
    );
    expect(result).toEqual({ accepted: true });
  });
});
