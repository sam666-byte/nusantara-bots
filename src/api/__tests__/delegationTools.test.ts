/**
 * Tests untuk tool delegasi antar-bot (delegationTools.ts,
 * video-parity Tahap 2).
 *
 * Aturan yang diuji: delegasi diputuskan model LEWAT TOOL, satu
 * panggilan = satu pesan delegasi ter-claim ke room target + penanda
 * ke room Chief; eksekutor TIDAK PERNAH mengklaim pekerjaan selesai
 * (itu tugas runner) dan TIDAK PERNAH mengarang target/room.
 */
import {
  HANDOFF_TO_BOT_TOOL,
  MESSAGE_BOT_TOOL,
  executeDelegationTool,
} from '../delegationTools';
import type { ParsedToolCall } from '../byo';

jest.mock('../client', () => ({
  getCharacters: jest.fn(),
  getRooms: jest.fn(),
  persistMessage: jest.fn(),
}));
jest.mock('../botChat', () => ({
  createBotChat: jest.fn(),
  roomIdFor: jest.fn(),
}));

import { getCharacters, getRooms, persistMessage } from '../client';
import { createBotChat, roomIdFor } from '../botChat';

const mockGetCharacters = getCharacters as jest.Mock;
const mockGetRooms = getRooms as jest.Mock;
const mockPersistMessage = persistMessage as jest.Mock;
const mockRoomIdFor = roomIdFor as jest.Mock;
const mockCreateBotChat = createBotChat as jest.Mock;

function call(name: string, args: unknown, argsValid = true): ParsedToolCall {
  return {
    id: 'call-1',
    name,
    args: args as Record<string, unknown>,
    argsRaw: JSON.stringify(args ?? {}),
    argsValid,
  };
}

const BOTS = [
  { id: 'xm', name: 'Chief', role: 'Chief', skills: [], memory_scope: 'team' },
  { id: 'spec-bot', name: 'Spec Bot', role: 'Spesialis', skills: [], memory_scope: 'team' },
];

const CTX = { chiefId: 'xm', chiefRoomId: 'xm-room' };

describe('MESSAGE_BOT_TOOL / HANDOFF_TO_BOT_TOOL', () => {
  it('mendefinisikan dua tool dengan nama yang benar', () => {
    expect(MESSAGE_BOT_TOOL.function.name).toBe('message_bot');
    expect(HANDOFF_TO_BOT_TOOL.function.name).toBe('handoff_to_bot');
    expect(MESSAGE_BOT_TOOL.function.description).toContain('runner server');
    expect(MESSAGE_BOT_TOOL.function.description).toContain('didelegasikan');
  });

  it('target tidak dikenal: gagal jujur, tidak ada pesan terkirim', async () => {
    mockGetCharacters.mockResolvedValue(BOTS);
    const out = await executeDelegationTool(
      call('message_bot', { target: 'tidak-ada', message: 'kerjakan X' }),
      CTX,
    );
    expect(out).toContain('tidak ditemukan');
    expect(mockPersistMessage).not.toHaveBeenCalled();
  });

  it('target dikenal dari nama: post delegasi ke room target + penanda ke room Chief', async () => {
    mockGetCharacters.mockResolvedValue(BOTS);
    mockGetRooms.mockResolvedValue([
      { id: 'spec-room', mode: 'chat', members: ['spec-bot'] },
    ]);
    mockRoomIdFor.mockReturnValue('spec-room');
    mockPersistMessage.mockResolvedValue({ message: { id: 1 } });
    const out = await executeDelegationTool(
      call('message_bot', { target: 'Spec Bot', message: 'kerjakan storyboard' }),
      CTX,
    );
    expect(out).toContain('Didelegasikan ke "Spec Bot"');
    // Jujur: hasil tool berkata "didelegasikan" dan melarang model
    // melaporkannya sebagai selesai sebelum hasil kembali.
    expect(out).toContain('Jangan laporkan pekerjaan ini sebagai selesai');
    expect(mockPersistMessage).toHaveBeenCalledTimes(2);
    const [targetCall, markerCall] = mockPersistMessage.mock.calls;
    expect(targetCall[0]).toBe('spec-room');
    expect(targetCall[5]).toMatchObject({
      kind: 'delegation',
      target_character: 'spec-bot',
      created_by: 'xm',
    });
    expect(markerCall[0]).toBe('xm-room');
    expect(markerCall[5]).toMatchObject({
      kind: 'delegation',
      target_character: 'spec-bot',
    });
  });

  it('room target belum ada: buatkan lewat createBotChat lalu pakai room itu', async () => {
    mockGetCharacters.mockResolvedValue(BOTS);
    mockGetRooms.mockResolvedValue([]);
    mockRoomIdFor.mockReturnValue('general');
    mockCreateBotChat.mockResolvedValue({
      roomId: 'spec-room-baru',
      characterId: 'spec-bot',
      title: 'Spec Bot',
    });
    mockPersistMessage.mockResolvedValue({ message: { id: 1 } });
    const out = await executeDelegationTool(
      call('handoff_to_bot', { target: 'spec-bot', message: 'lanjutkan tahap 2' }),
      CTX,
    );
    expect(mockCreateBotChat).toHaveBeenCalledTimes(1);
    expect(out).toContain('Diserahkan tahap berikutnya ke "Spec Bot"');
    expect(mockPersistMessage.mock.calls[0][0]).toBe('spec-room-baru');
  });

  it('argumen tidak valid: gagal jujur, tidak ada pesan terkirim', async () => {
    mockGetCharacters.mockResolvedValue(BOTS);
    const out = await executeDelegationTool(
      call('message_bot', { target: '', message: '' }),
      CTX,
    );
    expect(out).toContain('tidak dikirim');
    expect(mockPersistMessage).not.toHaveBeenCalled();
  });
});
