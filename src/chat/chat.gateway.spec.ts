import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { KafkaProducerService } from '../kafka/kafka.producer';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { Socket } from 'socket.io';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSocket(overrides: Partial<Socket['data']> = {}): Partial<Socket> {
  return {
    id:   'socket-test-1',
    data: {
      userId:          'user-1',
      username:        'alice',
      profilePhotoUrl: 'https://example.com/photo.jpg',
      stationId:       'station-42',
      ...overrides,
    },
  };
}

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockKafkaProducer = {
  publishChatMessage: jest.fn().mockResolvedValue(undefined),
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let serverEmitMock: jest.Mock;
  let serverToMock: jest.Mock;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: KafkaProducerService, useValue: mockKafkaProducer },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);

    // Inject a mock Socket.IO server
    serverEmitMock = jest.fn();
    serverToMock   = jest.fn().mockReturnValue({ emit: serverEmitMock });
    (gateway as any).server = { to: serverToMock };

    jest.clearAllMocks();
  });

  describe('handleSendChatMessage', () => {
    it('broadcasts new_chat_message to the station room', async () => {
      const socket = makeSocket() as Socket;
      const dto: SendChatMessageDto = { stationId: 'station-42', content: 'Hello chat!', mentions: [] };

      await gateway.handleSendChatMessage(socket, dto);

      expect(serverToMock).toHaveBeenCalledWith('station:station-42');
      expect(serverEmitMock).toHaveBeenCalledWith(
        'new_chat_message',
        expect.objectContaining({
          stationId: 'station-42',
          userId:    'user-1',
          username:  'alice',
          content:   'Hello chat!',
          mentions:  [],
        }),
      );
    });

    it('includes a generated messageId and ISO timestamp', async () => {
      const socket = makeSocket() as Socket;
      const dto: SendChatMessageDto = { stationId: 'station-42', content: 'Test' };

      await gateway.handleSendChatMessage(socket, dto);

      const emittedPayload = serverEmitMock.mock.calls[0][1];
      expect(emittedPayload.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(new Date(emittedPayload.timestamp).getTime()).not.toBeNaN();
    });

    it('publishes to Kafka with correct payload', async () => {
      const socket = makeSocket() as Socket;
      const dto: SendChatMessageDto = {
        stationId: 'station-42',
        content:   'Kafka test',
        mentions:  ['user-2'],
      };

      await gateway.handleSendChatMessage(socket, dto);

      expect(mockKafkaProducer.publishChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          station_id: 'station-42',
          user_id:    'user-1',
          username:   'alice',
          content:    'Kafka test',
          mentions:   ['user-2'],
        }),
      );
    });

    it('does nothing when socket has no stationId (user not in a station)', async () => {
      const socket = makeSocket({ stationId: undefined }) as Socket;
      const dto: SendChatMessageDto = { stationId: 'station-42', content: 'Should be dropped' };

      await gateway.handleSendChatMessage(socket, dto);

      expect(serverToMock).not.toHaveBeenCalled();
      expect(mockKafkaProducer.publishChatMessage).not.toHaveBeenCalled();
    });

    it('does nothing when socket has no userId (unauthenticated)', async () => {
      const socket = makeSocket({ userId: undefined }) as Socket;
      const dto: SendChatMessageDto = { stationId: 'station-42', content: 'Unauthenticated' };

      await gateway.handleSendChatMessage(socket, dto);

      expect(serverToMock).not.toHaveBeenCalled();
      expect(mockKafkaProducer.publishChatMessage).not.toHaveBeenCalled();
    });

    it('handles optional mentions defaulting to empty array', async () => {
      const socket = makeSocket() as Socket;
      const dto: SendChatMessageDto = { stationId: 'station-42', content: 'No mentions' };

      await gateway.handleSendChatMessage(socket, dto);

      const emittedPayload = serverEmitMock.mock.calls[0][1];
      expect(emittedPayload.mentions).toEqual([]);
    });
  });
});
