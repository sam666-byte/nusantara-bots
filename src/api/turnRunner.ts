/**
 * turnRunner — module-level registry for in-flight bot turns.
 *
 * Masalah (0.10.14, Issue 3 — PALING PARAH):
 * Pemanggilan model + tool loop hidup di dalam komponen ChatScreen.
 * Saat Sam keluar dari chat (navigasi pergi), komponen unmount — tapi
 * pekerjaan async-nya TETAP jalan di JS (tidak ada yang meng-abort).
 * Yang hilang adalah VISIBILITAS: instance ChatScreen yang baru tidak
 * tahu ada turn yang sedang berjalan, tidak menampilkan thinking /
 * streaming text, dan tidak punya pemicu reload saat turn selesai.
 * Sam melihat chat mati dan bertanya ulang.
 *
 * turnRunner adalah bus module-level (hidup di luar komponen mana pun)
 * yang melacak turn aktif per room:
 *  - send() mendaftarkan turn + mempublikasikan progres (text/thinking).
 *  - ChatScreen yang fokus berlangganan turn room-nya: bila ada turn
 *    aktif, UI menampilkan thinking + streaming text secara live; saat
 *    turn selesai, subscriber diberi tahu dan layar reload dari server.
 *  - Credential: bila turn butuh credential saat tidak ada layar yang
 *    fokus (form tidak bisa ditampilkan), request resolve {saved:false}
 *    alih-alih menggantung selamanya.
 *  - STOP dari layar baru tetap bisa menghentikan turn lama (controller
 *    terdaftar di sini, bukan di ref komponen yang sudah unmount).
 *
 * turnRunner TIDAK menjalankan model sendiri — eksekusi tetap di
 * ChatScreen.send() (perubahan minimal, risiko regresi rendah). Ia
 * hanya membuat turn yang sudah berjalan itu terlihat + bisa dihentikan.
 */

import type { CredentialFormResult } from './credentialTools';

export type TurnStatus = 'running' | 'done' | 'error' | 'stopped';

export interface TurnSnapshot {
  roomId: string;
  status: TurnStatus;
  /** Teks asisten yang sudah ter-stream sejauh ini (live). */
  text: string;
  /** Label tool/thinking saat ini (mis. "Menjalankan vm_exec…"). */
  thinking: string;
  updatedAt: number;
  error?: string;
  /**
   * Generasi turn (naik tiap registerTurn). Dipakai supaya turn LAMA
   * yang akhirnya selesai tidak menimpa turn BARU di room yang sama
   * (balapan STOP → kirim baru → finally turn lama).
   */
  generation: number;
  /** Waktu turn didaftarkan (ms epoch) — untuk batas usia maksimum. */
  createdAt: number;
}

export type TurnListener = (snap: TurnSnapshot) => void;

export type CredentialHandler = (input: {
  service: string;
  label: string;
  url: string;
}) => Promise<CredentialFormResult>;

const turns = new Map<string, TurnSnapshot>();
const controllers = new Map<string, AbortController>();
const listeners = new Map<string, Set<TurnListener>>();
let credentialHandler: CredentialHandler | null = null;
let generationCounter = 0;

function notify(roomId: string): void {
  const snap = turns.get(roomId);
  if (!snap) return;
  const subs = listeners.get(roomId);
  if (!subs) return;
  subs.forEach((fn) => {
    try {
      fn({ ...snap });
    } catch {
      // Listener yang rusak tidak boleh merusak turn.
    }
  });
}

/**
 * Daftarkan turn baru untuk sebuah room. Bila ada turn lama yang masih
 * 'running' di room yang sama, turn lama dianggap digantikan (status
 * 'stopped') agar layar tidak menampilkan dua turn sekaligus.
 */
export function registerTurn(
  roomId: string,
  controller: AbortController,
): TurnSnapshot {
  const prev = turns.get(roomId);
  if (prev && prev.status === 'running') {
    const stopped: TurnSnapshot = {
      ...prev,
      status: 'stopped',
      updatedAt: Date.now(),
    };
    turns.set(roomId, stopped);
    notify(roomId);
  }
  controllers.set(roomId, controller);
  const snap: TurnSnapshot = {
    roomId,
    status: 'running',
    text: '',
    thinking: '',
    updatedAt: Date.now(),
    generation: ++generationCounter,
    createdAt: Date.now(),
  };
  turns.set(roomId, snap);
  notify(roomId);
  return { ...snap };
}

/**
 * Publikasikan progres turn (streaming text / label tool). No-op bila
 * tidak ada turn, turn sudah selesai, atau generasi tidak cocok (turn
 * lama yang tertinggal — jangan timpa turn baru).
 */
export function updateTurn(
  roomId: string,
  patch: { text?: string; thinking?: string },
  generation?: number,
): void {
  const snap = turns.get(roomId);
  if (!snap || snap.status !== 'running') return;
  if (generation !== undefined && generation !== snap.generation) return;
  if (patch.text !== undefined) snap.text = patch.text;
  if (patch.thinking !== undefined) snap.thinking = patch.thinking;
  snap.updatedAt = Date.now();
  notify(roomId);
}

/**
 * Tandai turn selesai (done/error/stopped) dan beri tahu subscriber.
 * Bila generasi diberikan dan tidak cocok dengan turn saat ini (turn
 * lama yang akhirnya selesai setelah turn baru dimulai), no-op.
 */
export function completeTurn(
  roomId: string,
  status: Exclude<TurnStatus, 'running'>,
  generation?: number,
  error?: string,
): TurnSnapshot | null {
  const snap = turns.get(roomId);
  if (!snap) return null;
  if (generation !== undefined && generation !== snap.generation) return null;
  snap.status = status;
  snap.updatedAt = Date.now();
  if (error !== undefined) snap.error = error;
  controllers.delete(roomId);
  notify(roomId);
  return { ...snap };
}

/** Ambil snapshot turn terakhir untuk sebuah room (null bila tidak ada). */
export function getTurn(roomId: string): TurnSnapshot | null {
  const snap = turns.get(roomId);
  return snap ? { ...snap } : null;
}

/** Berlangganan perubahan turn sebuah room. Kembalikan fungsi unsubscribe. */
export function subscribeTurn(roomId: string, listener: TurnListener): () => void {
  let subs = listeners.get(roomId);
  if (!subs) {
    subs = new Set();
    listeners.set(roomId, subs);
  }
  subs.add(listener);
  return () => {
    const s = listeners.get(roomId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listeners.delete(roomId);
  };
}

/**
 * Hentikan turn yang sedang berjalan di sebuah room (abort controller
 * yang terdaftar). Dipakai tombol STOP dari layar mana pun — termasuk
 * layar baru yang tidak memiliki ref controller turn lama.
 * Mengembalikan true bila ada turn yang dihentikan.
 */
export function stopTurn(roomId: string): boolean {
  const controller = controllers.get(roomId);
  const snap = turns.get(roomId);
  if (!controller && (!snap || snap.status !== 'running')) return false;
  if (controller && !controller.signal.aborted) controller.abort();
  if (snap && snap.status === 'running') {
    completeTurn(roomId, 'stopped');
  }
  return true;
}

/**
 * Turn dianggap basi bila tidak ada progres (updateTurn) selama ini.
 * Turn kirim langsung selalu update lewat onDelta/onToolCall selagi
 * hidup — token mengalir, tool melapor — jadi 3 menit sunyi = mati
 * (mis. model 429 lalu stream tak kunjung selesai). Batas usia total
 * menjaga dari loop tool yang update terus tapi tak pernah selesai.
 */
export const STALE_TURN_MS = 3 * 60 * 1000;
export const MAX_TURN_MS = 30 * 60 * 1000;

/**
 * Bersihkan turn 'running' yang sudah mati (basi / terlalu tua).
 * Mengembalikan true bila ada turn yang dibersihkan. Dipanggil send()
 * sebelum guard isTurnRunning supaya turn menggantung tidak memblokir
 * kirim selamanya. Turn yang masih hidup (update < 3 menit, usia
 * < 30 menit) TIDAK disentuh.
 */
export function pruneStaleTurn(roomId: string): boolean {
  const snap = turns.get(roomId);
  if (!snap || snap.status !== 'running') return false;
  const age = Date.now() - snap.createdAt;
  const idle = Date.now() - snap.updatedAt;
  if (idle > STALE_TURN_MS || age > MAX_TURN_MS) {
    console.warn(
      '[turnRunner] membersihkan turn menggantung',
      roomId,
      { idleMs: idle, ageMs: age },
    );
    completeTurn(roomId, 'stopped');
    return true;
  }
  return false;
}

/** Apakah ada turn yang sedang berjalan di room ini. */
export function isTurnRunning(roomId: string): boolean {
  return turns.get(roomId)?.status === 'running';
}

/**
 * Daftarkan handler credential dari layar yang sedang fokus. Layar
 * membersihkannya (null) saat blur/unmount agar turn yang berjalan di
 * background tidak menggantung menunggu form yang tidak ada.
 */
export function setCredentialHandler(handler: CredentialHandler | null): void {
  credentialHandler = handler;
}

/**
 * Minta credential lewat handler layar yang fokus. Bila tidak ada layar
 * yang fokus (turn jalan di background), langsung resolve {saved:false}
 * supaya tool loop tidak menggantung selamanya — model akan menerima
 * hasil "credential tidak disimpan" dan melanjutkan/melapor, bukan diam.
 */
export async function requestCredentialViaRunner(input: {
  service: string;
  label: string;
  url: string;
}): Promise<CredentialFormResult> {
  if (credentialHandler) return credentialHandler(input);
  return { saved: false };
}

/** Reset penuh (hanya untuk test). */
export function __resetTurnRunnerForTests(): void {
  turns.clear();
  controllers.clear();
  listeners.clear();
  credentialHandler = null;
  generationCounter = 0;
}
