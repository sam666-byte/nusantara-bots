/**
 * Tool manajemen bot untuk chat BYO (0.9.11 — anti-halu).
 *
 * Akar masalah (tes Sam 26 Okt 14:09): Xman menjawab "Tim bot kamu
 * sudah saya bentuk — 4 orang" padahal TIDAK ADA bot yang terbentuk.
 * Xman tidak punya tool untuk membuat bot, jadi saat diminta
 * membentuk tim, model mengarang seolah sudah melakukannya.
 *
 * Perbaikan: beri model tool NYATA — `create_bot` (POST
 * /api/characters, endpoint yang sama dengan tombol "Buat bot" di
 * aplikasi) dan `list_bots` (GET /api/characters). Aturan kejujuran
 * ada di system prompt (api/systemPrompt): model HANYA boleh
 * mengklaim bot terbentuk bila tool mengembalikan sukses, dan HARUS
 * mengecek daftar bot dulu sebelum mengklaim tim sudah ada.
 *
 * Sisi aplikasi ini TIDAK mengarang apa pun: hasil tool adalah
 * respons server apa adanya (sukses / sudah ada / gagal). Bila
 * server menolak, model diberi tahu gagal — bukan dibiarkan
 * mengarang keberhasilan.
 */

import { ApiError } from './types';
import type { Character } from './types';
import { createCharacter, getCharacters, type CharacterFocus } from './client';
import { createBotChat } from './botChat';
import type { ChatTool, ParsedToolCall } from './byo';

export const CREATE_BOT_TOOL_NAME = 'create_bot';
export const LIST_BOTS_TOOL_NAME = 'list_bots';

/** Focus yang diterima POST /api/characters (sama seperti client). */
const VALID_FOCUS: readonly CharacterFocus[] = ['day-to-day', 'inbox', 'research', 'everything'];

/** Batas argumen create_bot (supaya model tidak mengirim sampah). */
export const CREATE_BOT_MAX_NAME_LENGTH = 60;
export const CREATE_BOT_MAX_ROLE_LENGTH = 120;
export const CREATE_BOT_MAX_SKILLS = 8;
export const CREATE_BOT_MAX_SKILL_LENGTH = 40;

/**
 * Tool `create_bot`: buat satu bot baru di server (benar-benar
 * terbentuk, bukan karangan). Dipakai saat pengguna meminta
 * membentuk tim / menambah bot.
 */
export const CREATE_BOT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: CREATE_BOT_TOOL_NAME,
    description:
      'Buat satu bot baru di server aplikasi. Bot yang dibuat BENAR-BENAR ada ' +
      '(bisa dilihat di Home) — pakai tool ini setiap kali pengguna ' +
      'meminta membuat bot atau membentuk tim, satu panggilan per bot. ' +
      'Jangan pernah mengklaim bot sudah dibuat tanpa memanggil tool ini dulu.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nama bot (wajib, contoh: "Scribe Bot").',
        },
        role: {
          type: 'string',
          description: 'Peran bot dalam satu kalimat (contoh: "Penulis naskah dan script").',
        },
        focus: {
          type: 'string',
          description:
            'Bidang kerja bot: "day-to-day" (tugas harian umum), "inbox" (email/pesan), ' +
            '"research" (riset), "everything" (serba bisa). Bila ragu, pakai "day-to-day".',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Daftar keahlian singkat (maks 8). HANYA pakai skill yang sudah ada di rak — cek dulu dengan list_skills. ' +
            'Bila ragu, kosongkan saja (bot tetap dibuat dengan skill default sesuai focus). Jangan mengarang nama skill.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

/**
 * Tool `list_bots`: daftar bot yang BENAR-BENAR ada di server.
 * Panggil tool ini SEBELUM mengklaim tim/bot sudah ada — jangan
 * pernah mengarang daftar bot dari ingatan.
 */
export const LIST_BOTS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: LIST_BOTS_TOOL_NAME,
    description:
      'Lihat daftar bot yang benar-benar ada di server saat ini (nama, id, peran). ' +
      'Panggil tool ini sebelum menjawab pertanyaan tentang tim atau bot yang sudah ada — ' +
      'jangan mengarang daftar bot.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

/** Semua tool manajemen bot (untuk ChatScreen). */
export const BOT_TOOLS: ChatTool[] = [CREATE_BOT_TOOL, LIST_BOTS_TOOL];

export type CreateBotArgs =
  | {
      ok: true;
      name: string;
      role?: string;
      focus: CharacterFocus;
      skills?: string[];
    }
  | { ok: false; error: string };

function isValidFocus(value: unknown): value is CharacterFocus {
  return typeof value === 'string' && (VALID_FOCUS as readonly string[]).includes(value);
}

/** Validasi argumen create_bot dari model (jangan kirim nama kosong). */
export function validateCreateBotArgs(args: unknown): CreateBotArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Argumen create_bot harus berupa objek dengan name.' };
  }
  const raw = args as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'Nama bot kosong — berikan name yang valid.' };
  }
  if (name.length > CREATE_BOT_MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: `Nama bot terlalu panjang (${name.length} karakter, maks ${CREATE_BOT_MAX_NAME_LENGTH}).`,
    };
  }
  let focus: CharacterFocus = 'day-to-day';
  if (raw.focus !== undefined) {
    if (!isValidFocus(raw.focus)) {
      return {
        ok: false,
        error: `Focus "${String(raw.focus)}" tidak dikenal — pakai salah satu: ${VALID_FOCUS.join(', ')}.`,
      };
    }
    focus = raw.focus;
  }
  let role: string | undefined;
  if (raw.role !== undefined) {
    if (typeof raw.role !== 'string') {
      return { ok: false, error: 'Role harus berupa teks.' };
    }
    role = raw.role.trim() || undefined;
    if (role && role.length > CREATE_BOT_MAX_ROLE_LENGTH) {
      return {
        ok: false,
        error: `Role terlalu panjang (${role.length} karakter, maks ${CREATE_BOT_MAX_ROLE_LENGTH}).`,
      };
    }
  }
  let skills: string[] | undefined;
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) {
      return { ok: false, error: 'Skills harus berupa daftar teks.' };
    }
    const cleaned = raw.skills
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, CREATE_BOT_MAX_SKILLS);
    for (const s of cleaned) {
      if (s.length > CREATE_BOT_MAX_SKILL_LENGTH) {
        return {
          ok: false,
          error: `Skill "${s}" terlalu panjang (maks ${CREATE_BOT_MAX_SKILL_LENGTH} karakter).`,
        };
      }
    }
    if (cleaned.length > 0) skills = cleaned;
  }
  return { ok: true, name, role, focus, skills };
}

/**
 * Eksekutor tool create_bot. TIDAK PERNAH throw — semua kegagalan
 * dikembalikan sebagai teks hasil tool supaya model melapor jujur.
 * Bot yang berhasil dibuat juga dibuatkan room 1-1 sendiri
 * (best-effort, seperti tombol "Buat bot" — gagal membuat room
 * tidak menggagalkan pembuatan bot).
 */
export async function executeCreateBotTool(
  call: ParsedToolCall,
  /** Video-parity Tahap 1: Chief pemanggil tool (untuk "Created by"). */
  createdBy?: string,
): Promise<string> {
  if (call.name !== CREATE_BOT_TOOL_NAME) {
    return 'Tool itu tidak dikenal di aplikasi ini.';
  }
  if (!call.argsValid) {
    return 'Argumen create_bot tidak valid (bukan JSON objek). Berikan name sebagai string.';
  }
  const checked = validateCreateBotArgs(call.args);
  if (!checked.ok) {
    return `Bot tidak dibuat: ${checked.error}`;
  }
  let created: Character | null;
  try {
    created = await createCharacter({
      name: checked.name,
      focus: checked.focus,
      role: checked.role,
      skills: checked.skills,
      created_by: createdBy,
    });
  } catch (e) {
    // 0.10.13: server menolak skill yang belum terdaftar di rak
    // (400 "unknown skill(s)") — model selalu mengarang nama skill
    // bebas ("riset", "analisis harga") sehingga create_bot GAGAL
    // terus (terbukti di emulator: "Riset Bot tidak terbentuk").
    // Skill itu opsional: coba lagi TANPA skill (server memakai
    // skill default sesuai focus) supaya bot tetap terbentuk.
    if (
      e instanceof ApiError &&
      e.status === 400 &&
      /unknown skill/i.test(e.message) &&
      checked.skills !== undefined
    ) {
      try {
        created = await createCharacter({
          name: checked.name,
          focus: checked.focus,
          role: checked.role,
          created_by: createdBy,
        });
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 409) {
          return `Bot "${checked.name}" tidak dibuat: sudah ada bot dengan nama itu. Pakai nama lain, atau cek dulu dengan list_bots.`;
        }
        return `Bot "${checked.name}" tidak dibuat: server menolak (${e2 instanceof Error ? e2.message : 'error tak dikenal'}). Beri tahu pengguna dengan jujur dan jangan mengklaim bot sudah ada.`;
      }
    } else {
      if (e instanceof ApiError && e.status === 409) {
        return `Bot "${checked.name}" tidak dibuat: sudah ada bot dengan nama itu. Pakai nama lain, atau cek dulu dengan list_bots.`;
      }
      return `Bot "${checked.name}" tidak dibuat: server menolak (${e instanceof Error ? e.message : 'error tak dikenal'}). Beri tahu pengguna dengan jujur dan jangan mengklaim bot sudah ada.`;
    }
  }
  if (!created) {
    return `Bot "${checked.name}" tidak dibuat: server meminta token. Beri tahu pengguna dengan jujur dan jangan mengklaim bot sudah ada.`;
  }
  // Room 1-1 sendiri (best-effort — seperti tombol "Buat bot").
  let roomNote = '';
  try {
    const target = await createBotChat(created, undefined, createdBy);
    if (target.roomId) roomNote = ` Room chat-nya: ${target.roomId}.`;
  } catch {
    roomNote = ' (Room chat-nya belum terbentuk — pengguna bisa membukanya dari Home.)';
  }
  return (
    `Bot dibuat: ${created.name} (id: ${created.id}, peran: ${created.role || '-'}).` + roomNote
  );
}

/**
 * Eksekutor tool list_bots. TIDAK PERNAH throw — kegagalan membaca
 * daftar dikembalikan sebagai teks jujur (bukan daftar karangan).
 */
export async function executeListBotsTool(call: ParsedToolCall): Promise<string> {
  if (call.name !== LIST_BOTS_TOOL_NAME) {
    return 'Tool itu tidak dikenal di aplikasi ini.';
  }
  let bots: Character[] | null;
  try {
    bots = await getCharacters();
  } catch {
    return 'Tidak bisa membaca daftar bot: server tidak menjawab. Jangan mengklaim bot apa pun — beri tahu pengguna server tidak terjangkau.';
  }
  if (!bots) {
    return 'Tidak bisa membaca daftar bot: server meminta token. Jangan mengklaim bot apa pun.';
  }
  if (bots.length === 0) {
    return 'Belum ada bot di server. Jangan mengklaim ada tim atau bot yang sudah terbentuk.';
  }
  const lines = bots.map((b) => `• ${b.name} (id: ${b.id}) — ${b.role || '-'}`);
  return `Bot yang ada di server (${bots.length}):\n${lines.join('\n')}`;
}

/**
 * Dispatcher tool manajemen bot untuk tool loop BYO. TIDAK PERNAH
 * throw — semua kegagalan dikembalikan sebagai teks hasil tool.
 */
export async function executeBotTool(
  call: ParsedToolCall,
  createdBy?: string,
): Promise<string> {
  if (call.name === CREATE_BOT_TOOL_NAME) return executeCreateBotTool(call, createdBy);
  if (call.name === LIST_BOTS_TOOL_NAME) return executeListBotsTool(call);
  return 'Tool itu tidak dikenal di aplikasi ini.';
}
