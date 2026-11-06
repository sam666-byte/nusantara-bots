/**
 * Tool memori + status tim untuk chat BYO (1 Nov 2026, lanjutan opsi 2).
 *
 * Aiden Bot butuh menyusun ringkasan harian dari memori tim + status bot
 * yang sedang berjalan, tapi tool-nya hanya kontrol browser. Tool ini
 * memberi model dua kemampuan lewat server (READ-ONLY, tidak pernah
 * mengubah apa pun):
 * - get_team_memory: memori per karakter (GET /api/memory?character=<id>)
 * - get_team_status: presence bot + mesin tim (GET /api/presence dan
 *   GET /api/computers) dalam satu hasil.
 *
 * Eksekutor TIDAK PERNAH throw — semua kegagalan dikembalikan sebagai teks
 * supaya model melapor jujur ("tidak bisa mengambil status tim"), bukan
 * mengarang angka, nama bot, atau status.
 */

import { apiJson } from './client';

import type { ChatTool, ParsedToolCall } from './byo';

export const GET_TEAM_MEMORY_TOOL_NAME = 'get_team_memory';
export const GET_TEAM_STATUS_TOOL_NAME = 'get_team_status';
export const SAVE_TEAM_MEMORY_TOOL_NAME = 'save_team_memory';

const MAX_TOTAL_CHARS = 6000;
const MAX_MEMORIES_PER_CHAR = 20;
const MAX_ROW_CHARS = 300;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

interface CharacterInfo {
  id: string;
  name?: string;
}

interface CharactersResponse {
  characters?: CharacterInfo[];
  error?: string;
}

interface MemoryResponse {
  character?: string;
  scopes?: string[];
  memories?: unknown[];
  error?: string;
}

function callArgs(call: ParsedToolCall): Record<string, unknown> {
  const a = (call as unknown as { args?: unknown }).args;
  if (a && typeof a === 'object') return a as Record<string, unknown>;
  return {};
}

async function fetchTeamMemory(call: ParsedToolCall): Promise<string> {
  const wantedRaw = callArgs(call).character;
  const wanted = typeof wantedRaw === 'string' ? wantedRaw.trim().toLowerCase() : '';
  const chars = await apiJson<CharactersResponse>('/api/characters').catch(
    () => null,
  );
  if (!chars || !Array.isArray(chars.characters) || chars.characters.length === 0) {
    return 'Tidak bisa mengambil daftar karakter tim dari server (server tidak menjawab atau daftar kosong). Jangan mengarang status tim; katakan bahwa daftar karakter tidak bisa diambil.';
  }
  let targets = chars.characters;
  if (wanted) {
    const found = chars.characters.filter(
      (c) =>
        c.id.toLowerCase() === wanted ||
        (c.name ?? '').toLowerCase() === wanted,
    );
    if (found.length === 0) {
      const names = chars.characters.map((c) => c.name ?? c.id).join(', ');
      return (
        'Karakter "' +
        String(wantedRaw) +
        '" tidak ditemukan di tim. Karakter yang ada: ' +
        names +
        '.'
      );
    }
    targets = found;
  }
  const lines: string[] = [];
  for (const ch of targets) {
    const mem = await apiJson<MemoryResponse>(
      '/api/memory?character=' + encodeURIComponent(ch.id),
    ).catch(() => null);
    if (!mem || !Array.isArray(mem.memories)) {
      lines.push(
        '- ' + (ch.name ?? ch.id) + ': memori tidak bisa diambil dari server.',
      );
      continue;
    }
    if (mem.memories.length === 0) {
      lines.push('- ' + (ch.name ?? ch.id) + ': tidak ada memori tersimpan.');
      continue;
    }
    lines.push(
      '- ' + (ch.name ?? ch.id) + ' (' + mem.memories.length + ' memori):',
    );
    for (const row of mem.memories.slice(0, MAX_MEMORIES_PER_CHAR)) {
      lines.push('  • ' + trunc(JSON.stringify(row), MAX_ROW_CHARS));
    }
  }
  return trunc(
    'Memori tim (dari server, apa adanya):\n' + lines.join('\n'),
    MAX_TOTAL_CHARS,
  );
}

async function fetchTeamStatus(): Promise<string> {
  const [presence, computers] = await Promise.all([
    apiJson<unknown>('/api/presence').catch(() => null),
    apiJson<unknown>('/api/computers').catch(() => null),
  ]);
  if (presence === null && computers === null) {
    return 'Status tim tidak bisa diambil dari server (server tidak menjawab). Jangan mengarang status bot; katakan bahwa status tidak bisa diambil.';
  }
  const parts: string[] = ['Status tim (dari server, apa adanya):'];
  parts.push(
    '- Presence bot: ' +
      trunc(JSON.stringify(presence ?? 'tidak tersedia'), 3000),
  );
  parts.push(
    '- Komputer tim: ' +
      trunc(JSON.stringify(computers ?? 'tidak tersedia'), 3000),
  );
  return trunc(parts.join('\n'), MAX_TOTAL_CHARS);
}

export const GET_TEAM_MEMORY_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: GET_TEAM_MEMORY_TOOL_NAME,
    description:
      'Ambil memori tim dari server Nusantara — pakai tool ini SETIAP KALI pengguna memintamu memeriksa memori tim, ' +
      'mengingat apa yang diketahui tim, atau menyusun ringkasan yang butuh data nyata tim. ' +
      'Tanpa argumen = memori SEMUA karakter tim; argumen character (id atau nama) = memori satu karakter itu saja. ' +
      'Hasil tool berisi memori yang benar — laporkan persis isinya, jangan pernah mengarang memori, ' +
      'dan bila tool gagal, katakan gagal dan alasannya.',
    parameters: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Opsional: id atau nama karakter (contoh: "x", "lumen"). Kosong = semua karakter tim.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const GET_TEAM_STATUS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: GET_TEAM_STATUS_TOOL_NAME,
    description:
      'Ambil status tim dari server Nusantara (presence bot + komputer tim) — pakai tool ini SETIAP KALI pengguna ' +
      'memintamu memeriksa bot mana yang sedang berjalan/aktif/offline, atau menyusun ringkasan yang butuh status nyata tim. ' +
      'Hasil tool berisi status yang benar — laporkan persis isinya, jangan pernah mengarang angka atau status bot, ' +
      'dan bila tool gagal, katakan gagal dan alasannya.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export const SAVE_TEAM_MEMORY_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: SAVE_TEAM_MEMORY_TOOL_NAME,
    description:
      'Simpan memori tim ke server Nusantara (POST /api/memory) — pakai tool ini SETIAP KALI pengguna memintamu menyimpan atau mengingat sesuatu secara permanen. ' +
      'Argumen character (id atau nama bot pemilik memori, contoh: "chief") dan text (isi yang disimpan, contoh: "nama proyek tes: PROYEK-WAYDROID-789") WAJIB diisi. ' +
      'Setelah menyimpan, VERIFIKASI dengan get_team_memory dan hanya klaim sukses bila teks yang disimpan benar-benar muncul di hasil baca-ulang; ' +
      'bila baca-ulang kosong, katakan penyimpanan gagal, jangan mengklaim sukses.',
    parameters: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'Id atau nama bot pemilik memori (contoh: "chief").',
        },
        text: {
          type: 'string',
          description: 'Isi memori yang disimpan.',
        },
      },
      required: ['character', 'text'],
      additionalProperties: false,
    },
  },
};

async function saveTeamMemory(call: ParsedToolCall): Promise<string> {
  const raw = (call.args ?? {}) as Record<string, unknown>;
  const character = typeof raw['character'] === 'string' ? (raw['character'] as string).trim() : '';
  const text = typeof raw['text'] === 'string' ? (raw['text'] as string).trim() : '';
  if (!character || !text) {
    return 'Argumen save_team_memory tidak lengkap: character dan text wajib diisi. Penyimpanan TIDAK dilakukan — jangan mengklaim tersimpan.';
  }
  const res = await apiJson<{ character: string; ids: Record<string, number>; scopes: string[] }>('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character, text }),
  }).catch(() => null);
  if (!res || typeof res.character !== 'string') {
    return 'Gagal menyimpan memori tim: server tidak menjawab atau menolak. Penyimpanan TIDAK terjadi — jangan mengklaim tersimpan.';
  }
  return `Memori tersimpan di server untuk "${res.character}" (ids: ${JSON.stringify(res.ids)}, scopes: ${(res.scopes ?? []).join(', ')}). VERIFIKASI dengan get_team_memory sebelum mengklaim sukses ke pengguna.`;
}

export async function executeTeamTool(call: ParsedToolCall): Promise<string> {
  try {
    if (call.name === GET_TEAM_MEMORY_TOOL_NAME) return await fetchTeamMemory(call);
    if (call.name === SAVE_TEAM_MEMORY_TOOL_NAME) return await saveTeamMemory(call);
    if (call.name === GET_TEAM_STATUS_TOOL_NAME) return await fetchTeamStatus();
  } catch (e) {
    return (
      'Gagal mengambil data tim dari server: ' +
      (e instanceof Error ? e.message : String(e)) +
      '. Jangan mengarang data; laporkan kegagalan ini.'
    );
  }
  return 'Tool tim itu tidak dikenal.';
}
