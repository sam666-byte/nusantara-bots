/**
 * Tool delegasi antar-bot untuk chat BYO (video-parity Tahap 2).
 *
 * Pola (bukan copy kode produk lain): delegasi diputuskan model
 * Chief LEWAT TOOL, bukan ditebak dari teks pengguna dan bukan
 * dari pengguna yang mengetik nama bot tujuan. Satu panggilan tool
 * = satu pesan delegasi yang ter-claim (lihat runner Tahap 3):
 * pesan itu yang nanti dieksekusi server-side, jadi pengguna tidak
 * pernah menulis prefix apa pun dan tidak pernah mengetik @bot.
 *
 * Eksekutor ini TIDAK MENJALANKAN target — ia hanya memposting
 * delegasi ke room target dan penandanya ke room Chief (Tahap 1).
 * Menjalankan target adalah tugas runner; mengklaim sudah jalan
 * sebelum runner mengerjakannya adalah karangan dan dilarang di
 * sini: hasil tool selalu berkata "didelegasikan", bukan "selesai".
 *
 * Sisi aplikasi ini TIDAK mengarang apa pun: hasil tool adalah
 * respons server apa adanya (sukses / tidak ditemukan / gagal).
 */

import { ApiError } from './types';

import { createDelegation, getDelegations } from './client';
import type { DelegationRecord } from './client';

import type { ChatTool, ParsedToolCall } from './byo';

export const MESSAGE_BOT_TOOL_NAME = 'message_bot';
export const HANDOFF_TO_BOT_TOOL_NAME = 'handoff_to_bot';

/** Konteks Chief yang menjalankan tool (dari layar Chat pemanggil). */
export interface DelegationContext {
  /** Id bot Chief yang mendelegasikan (boleh null bila tidak diketahui). */
  chiefId: string | null;
  /** Room Chief tempat pengguna sedang chat. */
  chiefRoomId: string;
}

export const MESSAGE_BOT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: MESSAGE_BOT_TOOL_NAME,
    description:
      'Kirim tugas, pertanyaan, atau hasil ke bot lain yang benar-benar ada di server. ' +
      'Pakai tool ini SETIAP KALI pekerjaan butuh bot lain — jangan pernah menulis di balasanmu ' +
      'seolah bot lain akan mengerjakannya tanpa memanggil tool ini, dan jangan pernah meminta ' +
      'pengguna mengetik nama bot tujuan. Bot tujuan TIDAK langsung bekerja saat tool ini ' +
      'dipanggil: tool ini hanya membuat record delegasi di server; runner mengeksekusinya ' +
      'dan hasilnya kembali ke room ini. Jadi laporkan "didelegasikan", bukan "selesai".',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Bot tujuan: id-nya, atau nama persisnya (contoh: "yt-analytics"). ' +
            'Cek dulu dengan list_bots bila ragu — jangan mengarang id/nama.',
        },
        message: {
          type: 'string',
          description: 'Apa yang harus dikerjakan / ditanyakan / disampaikan.',
        },
        intent: {
          type: 'string',
          enum: ['request', 'result', 'question', 'status', 'fyi'],
          description: 'Apa yang harus dilakukan penerima dengan pesan ini. Default: request.',
        },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
  },
};

export const HANDOFF_TO_BOT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: HANDOFF_TO_BOT_TOOL_NAME,
    description:
      'Serahkan tahap berikutnya yang benar-benar beda ke anggota tim lain. ' +
      'Pakai tool ini bila satu tahap sudah selesai di tanganmu dan tahap berikutnya ' +
      'adalah pekerjaan spesialis lain — bukan untuk sekadar melaporkan atau mengulang ' +
      'pekerjaan yang sama. Sama seperti message_bot, tool ini hanya mengantarkan tugasnya; ' +
      'runner server yang mengeksekusinya dan hasilnya kembali ke room ini.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Bot tujuan: id-nya, atau nama persisnya. Cek dulu dengan list_bots bila ragu.',
        },
        message: {
          type: 'string',
          description: 'Apa yang harus dikerjakan bot penerima pada tahap berikutnya.',
        },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
  },
};

export const CHECK_DELEGATION_STATUS_TOOL_NAME = 'check_delegation_status';

/**
 * Fase 9: baca status NYATA delegasi dari server. Chief WAJIB memanggil
 * tool ini sebelum melaporkan status delegasi apa pun ke pengguna —
 * kasus 31 Okt 21:56 membuktikan model menebak status sampai kebalik
 * (Lumen dikira jalan padahal failed 429, Echo dikira gagal padahal done).
 * Tool ini read-only: tidak membuat delegasi baru, tidak menjalankan bot.
 */
export const CHECK_DELEGATION_STATUS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: CHECK_DELEGATION_STATUS_TOOL_NAME,
    description:
      'Cek status NYATA delegasi dari server (queued/claimed/done/failed) beserta hasil/galanya. ' +
      'PANGGIL tool ini SETIAP KALI kamu akan melaporkan status delegasi ke pengguna — sebelum menulis ' +
      '"sudah jalan", "gagal", "selesai", atau "belum bekerja". Jangan pernah menebak status dari ingatan ' +
      'percakapan: status yang benar HANYA yang dikembalikan tool ini. Tool ini read-only, tidak membuat ' +
      'delegasi baru dan tidak menjalankan bot. Tanpa id, hasil ditampilkan sebagai cuplikan 80 karakter; untuk HASIL LENGKAP satu delegasi, panggil dengan id-nya.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Opsional: id atau nama bot tujuan untuk memfilter (contoh: "lumen-scout"). Kosongkan untuk semua delegasi terbaru.',
        },
        id: {
          type: 'number',
          description:
            'Opsional: id delegasi spesifik (contoh: 1) untuk mengambil hasil lengkap tanpa potongan.',
        },
      },
      additionalProperties: false,
    },
  },
};

/** Semua tool delegasi (untuk ChatScreen, di samping BOT_TOOLS). */
export const DELEGATION_TOOLS: ChatTool[] = [MESSAGE_BOT_TOOL, HANDOFF_TO_BOT_TOOL, CHECK_DELEGATION_STATUS_TOOL];

type DelegationArgs =
  | { ok: true; target: string; message: string; intent?: string }
  | { ok: false; error: string };

function normId(value: string): string {
  return value.toLowerCase().replace(/[-_ ]/g, '');
}

function validateDelegationArgs(args: unknown, toolName: string): DelegationArgs {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: `Argumen ${toolName} harus berupa objek dengan target dan message.` };
  }
  const raw = args as Record<string, unknown>;
  const target = typeof raw.target === 'string' ? raw.target.trim() : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (!target) return { ok: false, error: 'Target bot kosong — berikan id atau nama bot tujuan.' };
  if (!message) return { ok: false, error: 'Pesan delegasi kosong — berikan tugas yang harus dikerjakan.' };
  let intent: string | undefined;
  if (toolName === MESSAGE_BOT_TOOL_NAME && raw.intent !== undefined) {
    if (typeof raw.intent !== 'string') {
      return { ok: false, error: 'intent harus berupa teks.' };
    }
    const cleaned = raw.intent.trim();
    if (!['request', 'result', 'question', 'status', 'fyi'].includes(cleaned)) {
      return { ok: false, error: `intent "${cleaned}" tidak dikenal — pakai request/result/question/status/fyi.` };
    }
    intent = cleaned;
  }
  return { ok: true, target, message, intent };
}

/**
 * Eksekutor tool delegasi. TIDAK PERNAH throw — semua kegagalan
 * dikembalikan sebagai teks hasil tool supaya model melapor jujur.
 *
 * Langkah: (1) kenali target dari daftar bot server (id atau nama
 * persis, bukan karangan); (2) cari room 1-1 target, buatkan bila
 * belum ada (best-effort, seperti tombol "Buat bot"); (3) post
 * pesan kind=delegation ke room target; (4) post penanda yang sama
 * ke room Chief supaya pengguna melihat "Messaged X >" di chatnya.
 */
export async function executeDelegationTool(
  call: ParsedToolCall,
  ctx: DelegationContext,
): Promise<string> {
  const toolName = call.name;
  if (toolName !== MESSAGE_BOT_TOOL_NAME && toolName !== HANDOFF_TO_BOT_TOOL_NAME) {
    return 'Tool itu tidak dikenal di aplikasi ini.';
  }
  if (!call.argsValid) {
    return `Argumen ${toolName} tidak valid (bukan JSON objek). Berikan target dan message sebagai string.`;
  }
  const checked = validateDelegationArgs(call.args, toolName);
  if (!checked.ok) {
    return `Delegasi tidak dikirim: ${checked.error}`;
  }
  const taskText =
    toolName === HANDOFF_TO_BOT_TOOL_NAME
      ? `Serahan tahap berikutnya dari Chief: ${checked.message}`
      : checked.message;
  // Kunci dedupe: retry tool yang sama tidak mengirim dua kali.
  let hash = 0;
  const keySrc = `${ctx.chiefId ?? ''}:${checked.target}:${taskText}`;
  for (let i = 0; i < keySrc.length; i += 1) {
    hash = (hash * 31 + keySrc.charCodeAt(i)) | 0;
  }
  const deliveryKey = `dlg:${ctx.chiefId ?? 'user'}:${Math.abs(hash)}`;
  let created;
  try {
    created = await createDelegation({
      target: checked.target,
      message: taskText,
      intent: checked.intent,
      chief_id: ctx.chiefId,
      chief_room_id: ctx.chiefRoomId,
      delivery_key: deliveryKey,
    });
  } catch (e) {
    return (
      `Delegasi tidak dikirim: server menolak ` +
      `(${e instanceof Error ? e.message : 'error tak dikenal'}). ` +
      'Jangan mengklaim delegasi sudah terkirim.'
    );
  }
  if (!created) {
    return (
      'Delegasi tidak dikirim: server tidak menjawab. ' +
      'Jangan mengklaim delegasi sudah terkirim.'
    );
  }
  if (!created.ok) {
    return (
      `Delegasi tidak dikirim: ${created.error}. ` +
      'Jangan mengklaim delegasi sudah terkirim.'
    );
  }
  const rec = created.delegation;
  const verb =
    toolName === HANDOFF_TO_BOT_TOOL_NAME
      ? 'Diserahkan tahap berikutnya ke'
      : 'Didelegasikan ke';
  return (
    `${verb} "${rec.target_name}" (delegasi #${rec.id}, room ${rec.target_room}). ` +
    `Tugas sudah diantarkan sebagai record server` +
    `${created.replayed ? ' (pengiriman ulang — record yang sama, tidak ganda)' : ''}; ` +
    'runner akan mengeksekusinya dan hasilnya kembali ke room ini. ' +
    'Jangan laporkan pekerjaan ini sebagai selesai sebelum hasilnya kembali.'
  );
}

/**
 * Eksekutor check_delegation_status. TIDAK PERNAH throw — semua kegagalan
 * dikembalikan sebagai teks supaya model melapor jujur ("tidak bisa dicek"),
 * bukan menebak status.
 */
export async function executeDelegationStatusTool(
  call: ParsedToolCall,
): Promise<string> {
  try {
    if (!call.argsValid) {
      return 'Argumen check_delegation_status tidak valid (bukan JSON objek).';
    }
    const raw = (call.args ?? {}) as Record<string, unknown>;
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    const all: DelegationRecord[] = [];
    for (const st of ['queued', 'claimed', 'done', 'failed']) {
      try {
        const list = await getDelegations(st);
        if (list) all.push(...list);
      } catch {
        // Satu status gagal dibaca — lanjut ke status lain.
      }
    }
    const rawId = raw['id'];
    const idNum = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' ? parseInt(rawId, 10) : NaN);
    if (!Number.isNaN(idNum)) {
      const found = all.find((r) => r.id === idNum);
      if (!found) {
        return `Tidak ada delegasi #${idNum} di server. Jangan mengklaim delegasi itu ada — recordnya memang tidak ada.`;
      }
      const fullTask = (found.message ?? '').trim();
      const fullRes = (found.result ?? '').trim();
      const fullErr = (found.error ?? '').trim();
      let out = `#${found.id} ${found.target_name || found.target} [${found.status}] (hasil lengkap, tidak dipotong)`;
      if (fullTask) out += `\ntugas: ${fullTask}`;
      if (fullErr) out += `\ngalat: ${fullErr}`;
      out += `\nhasil: ${fullRes || '(belum ada hasil)'}`;
      return out;
    }
    let rows = all;
    if (target) {
      const want = normId(target);
      rows = all.filter(
        (r) => normId(r.target) === want || normId(r.target_name ?? '') === want,
      );
    }
    rows.sort((a, b) => b.id - a.id);
    rows = rows.slice(0, 10);
    if (rows.length === 0) {
      return target
        ? `Tidak ada record delegasi untuk "${target}" di server. Jangan mengklaim delegasi itu ada, terkirim, atau gagal — recordnya memang tidak ada.`
        : 'Tidak ada record delegasi di server.';
    }
    const snip = (s: string | null | undefined, n: number) =>
      (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lines = rows.map((r) => {
      const bits = [`#${r.id} ${r.target_name || r.target} [${r.status}]`];
      const task = snip(r.message, 80);
      if (task) bits.push(`tugas: ${task}`);
      const err = snip(r.error, 80);
      if (err) bits.push(`galat: ${err}`);
      const resFull = (r.result ?? '');
      const res = snip(r.result, 80);
      if (res) bits.push(resFull.length > 80 ? `hasil: ${res} … [cuplikan, total ${resFull.length} karakter — panggil lagi dengan id ${r.id} untuk hasil lengkap]` : `hasil: ${res}`);
      return bits.join(' | ');
    });
    return (
      'Status delegasi dari server (inilah kebenarannya — laporkan persis ini, jangan ditambah tebakan):\n' +
      lines.join('\n')
    );
  } catch (e) {
    return `Gagal membaca status delegasi dari server (${e instanceof Error ? e.message : 'error tak dikenal'}). Jangan menebak status — katakan bahwa status tidak bisa dicek saat ini.`;
  }
}
