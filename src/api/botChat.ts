/**
 * Chat 1-1 bot — resolusi room + pembuatan room saat bot baru dibuat
 * (0.9.6, permintaan Sam).
 *
 * Dua laporan Sam yang akarnya sama:
 * 1. "Bot habis di hapus bikin bot baru malahan data bot lama yg
 *    keluar" — bot baru tidak punya room sendiri (server tidak
 *    membuatkan room saat POST /api/characters), jadi chat-nya jatuh
 *    ke room "general" yang masih menyimpan SEMUA pesan lama
 *    (termasuk pesan bot yang sudah dihapus — server tidak menghapus
 *    pesan saat DELETE /api/characters/:id). Solusi di aplikasi:
 *    setiap bot baru langsung dibuatkan room 1-1 sendiri
 *    (createBotChat), jadi chat-nya mulai KOSONG. Solusi di server
 *    (spesifikasi di BUILD-0.9.6-HANDOFF.md): DELETE bot juga harus
 *    menghapus pesan-pesan bot itu dari chat.json.
 * 2. "Jadi harus keluar kalo mau gunakan" — setelah "Buat Bot",
 *    aplikasi harus langsung masuk ke chat bot baru itu (dengan
 *    room-nya yang baru), tanpa perlu keluar dulu. createBotChat
 *    mengembalikan target navigasi lengkap (roomId + characterId)
 *    supaya CreateSheet bisa `replace` ke Chat yang benar.
 *
 * roomIdFor adalah implementasi kanonik yang dipakai HomeScreen dan
 * ChatScreen (sebelumnya logika yang sama diduplikasi di dua file).
 */

import { createRoom } from './client';
import type { Character, Room } from './types';

/**
 * Room chat 1-1 untuk satu bot: room mode "chat" yang anggotanya
 * memuat id bot, diutamakan yang anggotanya hanya bot itu (sama
 * seperti deck web); bila tidak ada, jatuh ke room "general".
 */
export function roomIdFor(characterId: string, rooms: Room[]): string {
  const own = rooms.filter(
    (r) => r.mode === 'chat' && (r.members ?? []).includes(characterId),
  );
  const single = own.find((r) => (r.members ?? []).length === 1);
  return (single ?? own[0])?.id ?? 'general';
}

/** Target navigasi ke layar Chat untuk satu bot. */
export interface BotChatTarget {
  /** Room 1-1 bot — ada bila berhasil dibuat/ditemukan. */
  roomId?: string;
  characterId: string;
  title: string;
}

/**
 * Buatkan room 1-1 untuk bot yang baru dibuat, lalu kembalikan
 * target navigasi ke Chat-nya. `createRoomFn` bisa di-inject untuk
 * test; produksi memakai createRoom (POST /api/rooms).
 *
 * Bila pembuatan room gagal (server error / 401), kembalikan target
 * tanpa roomId — Chat akan memakai resolusi roomIdFor seperti biasa
 * (fallback ke "general"). Gagal membuat room tidak boleh
 * menggagalkan pembuatan bot.
 */
export async function createBotChat(
  bot: Character,
  createRoomFn: (input: {
    name: string;
    members?: string[];
    mode?: 'chat' | 'meeting' | 'space';
    created_by?: string;
  }) => Promise<Room | null> = createRoom,
  /** Video-parity Tahap 1: Chief pembuat bot (untuk "Created by"). */
  createdBy?: string,
): Promise<BotChatTarget> {
  const fallback: BotChatTarget = { characterId: bot.id, title: bot.name };
  try {
    const room = await createRoomFn({
      name: bot.name,
      members: [bot.id],
      mode: 'chat',
      created_by: createdBy,
    });
    if (!room) return fallback;
    return { roomId: room.id, characterId: bot.id, title: bot.name };
  } catch {
    return fallback;
  }
}
