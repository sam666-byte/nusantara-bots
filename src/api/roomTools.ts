/**
 * Tool bikin ruangan untuk chat BYO (permintaan Sam 1 Nov 2026).
 *
 * Server SUDAH mendukung POST /api/rooms dan client SUDAH punya
 * createRoom — yang hilang hanya tool-nya untuk model. Sebelum patch
 * ini, model tidak punya cara apa pun untuk membuat ruangan, sehingga
 * permintaan "bikin ruangan yang isinya kamu dan bot kamu" tidak bisa
 * dipenuhi model (kasus 1 Nov 08:37).
 *
 * Eksekutor ini TIDAK PERNAH throw — semua kegagalan dikembalikan
 * sebagai teks supaya model melapor jujur ("ruangan tidak dibuat"),
 * bukan mengarang id ruangan. Id pemanggil OTOMATIS ditambahkan ke
 * anggota bila model tidak menyebutkannya, supaya Chief tidak
 * tertinggal dari ruangannya sendiri. Server membuang diam-diam id
 * anggota yang bukan bot yang ada — eksekutor melaporkan id yang
 * terbuang itu, supaya model tidak mengklaim mereka ikut.
 */

import { createRoom } from './client';
import type { Room } from './types';

import type { ChatTool, ParsedToolCall } from './byo';

export const CREATE_ROOM_TOOL_NAME = 'create_room';

/** Konteks pemanggil (dari layar Chat pemanggil). */
export interface CreateRoomContext {
  /** Id bot yang meminta ruangan (boleh null bila tidak diketahui). */
  callerId: string | null;
}

export const CREATE_ROOM_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: CREATE_ROOM_TOOL_NAME,
    description:
      'Buat ruangan baru di server — untuk rapat tim (mode meeting) atau ruang chat bersama (mode chat). ' +
      'Pakai tool ini SETIAP KALI pengguna memintamu membuat ruangan, room, atau rapat yang berisi kamu dan bot lain — ' +
      'jangan pernah menulis seolah ruangan sudah dibuat tanpa memanggil tool ini, dan jangan pernah mengarang id ruangan. ' +
      'Sertakan anggota dengan id bot yang benar (cek dulu dengan list_bots bila ragu — jangan mengarang id); ' +
      'id-mu sendiri otomatis ditambahkan bila tidak kamu sebutkan. ' +
      'Mode meeting untuk rapat tim, chat untuk ruang chat biasa. ' +
      'Hasil tool berisi id ruangan yang benar — laporkan id itu persis, dan beri tahu pengguna bahwa ruangan bisa dibuka dari daftar ruangan.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nama ruangan (wajib, contoh: "Rapat Tim").',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Id bot anggota (contoh: ["lumen-scout", "echo-scribe"]). ' +
            'Id yang bukan bot yang ada akan dibuang server — hasil tool akan menyebutkannya.',
        },
        mode: {
          type: 'string',
          enum: ['chat', 'meeting', 'space'],
          description:
            'Jenis ruangan: "meeting" bila pengguna bilang rapat, "chat" untuk ruang chat biasa. Default: chat.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

export async function executeCreateRoomTool(
  call: ParsedToolCall,
  ctx: CreateRoomContext,
): Promise<string> {
  try {
    if (!call.argsValid) {
      return 'Ruangan tidak dibuat: argumen create_room tidak valid (bukan JSON objek). Jangan mengklaim ruangan sudah dibuat.';
    }
    const raw = (call.args ?? {}) as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      return 'Ruangan tidak dibuat: nama ruangan wajib diisi. Jangan mengklaim ruangan sudah dibuat.';
    }
    const asked: string[] = Array.isArray(raw.members)
      ? (raw.members as unknown[])
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim())
          .filter((m) => m.length > 0)
      : [];
    const mode =
      raw.mode === 'meeting' || raw.mode === 'space' || raw.mode === 'chat'
        ? raw.mode
        : 'chat';
    const members = [...asked];
    if (ctx.callerId && !members.includes(ctx.callerId)) {
      members.unshift(ctx.callerId);
    }
    let room: Room | null;
    try {
      room = await createRoom({
        name,
        members,
        mode,
        created_by: ctx.callerId ?? undefined,
      });
    } catch (e) {
      return (
        'Ruangan tidak dibuat: server menolak ' +
        '(' +
        (e instanceof Error ? e.message : 'error tak dikenal') +
        '). Jangan mengklaim ruangan sudah dibuat.'
      );
    }
    if (!room) {
      return 'Ruangan tidak dibuat: server tidak menjawab (mungkin butuh login ulang). Jangan mengklaim ruangan sudah dibuat.';
    }
    const dropped = members.filter((m) => !room.members.includes(m));
    let out =
      'Ruangan dibuat: "' +
      room.name +
      '" (id ' +
      room.id +
      ', mode ' +
      room.mode +
      ', anggota: ' +
      (room.members.length > 0 ? room.members.join(', ') : 'tidak ada') +
      '). Beri tahu pengguna id ruangan ini persis seperti di atas dan bahwa ruangan bisa dibuka dari daftar ruangan.';
    if (dropped.length > 0) {
      out +=
        ' Perhatian: id berikut tidak dikenal server dan TIDAK dimasukkan: ' +
        dropped.join(', ') +
        '. Katakan itu ke pengguna, jangan mengklaim mereka ikut.';
    }
    return out;
  } catch (e) {
    return (
      'Ruangan tidak dibuat (' +
      (e instanceof Error ? e.message : 'error tak dikenal') +
      '). Jangan mengklaim ruangan sudah dibuat.'
    );
  }
}
