/**
 * HTTP client for the own-build Python server (../app/server.py).
 *
 * The app is NOT same-origin with the server, so every call goes to
 * the stored server base URL. The default below is a placeholder —
 * set your own server address in Settings (Server URL). The access
 * token is sent ONLY as the `X-Grokbot-Token` header, and
 * only when one is stored — the LAN-open server needs none.
 *
 * HARD INVARIANT: no function in this module ever puts a credential
 * (BYO key, API key, token, secret, password, …) into a request
 * body sent to /api/*. The server itself rejects such fields
 * (REJECTED_FIELDS in server.py) and the BYO credential never
 * leaves secure storage towards the server.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ApiError,
  CapCheck,
  Character,
  ChatMessage,
  CostRecord,
  HealthReport,
  MemoryEntry,
  MockChatResponse,
  PersistMessageResponse,
  Room,
  SaveMemoryResponse,
  ServerTurn,
  SkillInfo,
} from './types';

/**
 * Default server URL (placeholder). Replace YOUR_SERVER with the
 * address of your own server (for example http://your-server:8780)
 * in Settings → Server URL. The stored value, once set, overrides
 * this default.
 */
export const DEFAULT_SERVER_URL = 'http://YOUR_SERVER:8780';
/** Timeout untuk persist/load chat (0.10.12) — fetch polos tanpa timeout bisa gantung selamanya. */
export const CHAT_TIMEOUT_MS = 10000;
export const SERVER_URL_KEY = 'grokbot_server_url';
export const AUTH_TOKEN_KEY = 'grokbot_auth';
export const HEALTH_TIMEOUT_MS = 5000;

/** Focus values accepted by POST /api/characters (FOCUS_DEFAULTS). */
export type CharacterFocus = 'day-to-day' | 'inbox' | 'research' | 'everything';

/**
 * 0.10.9: normalisasi fokus ke kode server sebelum POST.
 * Server hanya menerima kode Inggris ('day-to-day' | 'inbox' |
 * 'research' | 'everything'); label Indonesia yang tampil di chip
 * UI ("Sehari-hari", "Riset", "Serba bisa") TIDAK boleh lolos ke
 * body. Menerima kode maupun label (kebal kalau suatu saat state
 * terisi label) dan mengembalikan kode kanonik — default
 * 'day-to-day' bila tidak dikenal.
 */
const FOCUS_CODE_BY_LABEL: Record<string, CharacterFocus> = {
  'day-to-day': 'day-to-day',
  'sehari-hari': 'day-to-day',
  inbox: 'inbox',
  research: 'research',
  riset: 'research',
  everything: 'everything',
  'serba bisa': 'everything',
};

export function focusCodeFor(value: string): CharacterFocus {
  return FOCUS_CODE_BY_LABEL[value.trim().toLowerCase()] ?? 'day-to-day';
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function getServerUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(SERVER_URL_KEY);
  return stored ? normalizeBaseUrl(stored) : DEFAULT_SERVER_URL;
}

export async function setServerUrl(url: string): Promise<void> {
  const clean = normalizeBaseUrl(url);
  if (!clean) throw new Error('Server URL must not be empty.');
  await AsyncStorage.setItem(SERVER_URL_KEY, clean);
}

export async function getAuthToken(): Promise<string> {
  return (await AsyncStorage.getItem(AUTH_TOKEN_KEY)) || '';
}

/** Pass '' to clear the stored token. */
export async function setAuthToken(token: string): Promise<void> {
  const clean = token.trim();
  if (!clean) {
    await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
    return;
  }
  await AsyncStorage.setItem(AUTH_TOKEN_KEY, clean);
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { 'X-Grokbot-Token': token } : {};
}

/**
 * Low-level fetch against the stored server base URL.
 * Adds the auth header when a token is stored. Throws ApiError on
 * non-2xx (except 401, which is returned as-is for callers that
 * treat it as "needs token").
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await getServerUrl();
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  return fetch(`${base}${path}`, { ...init, headers });
}

/**
 * apiFetch dengan batas waktu (0.10.8, perbaikan mirror Team
 * Computer STALE). fetch polos TIDAK PUNYA timeout: satu fetch
 * layar/status yang menggantung (WiFi putus / server restart)
 * membuat pemanggil yang memakai guard "sedang fetch" macet
 * selamanya (finally tidak pernah jalan) sehingga poll mirror
 * berhenti dan gambar beku di frame lama. Dengan timeout, fetch
 * yang menggantung dibatalkan (AbortError) dan poll berikutnya
 * bisa jalan lagi. Dipakai getComputerStatus/getComputerScreen.
 */
export async function apiFetchTimeout(
  path: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch dengan timeout (tanpa retry).
 *
 * Dulu fungsi ini mencoba SEKALI ke URL alternatif bila jaringan
 * gagal (fallback dua jalur). Versi publik ini hanya punya satu
 * server URL yang dikonfigurasi pengguna, jadi tidak ada alternatif
 * yang dikenal — satu percobaan dengan timeout saja. Respons HTTP
 * (termasuk non-2xx seperti 400/429) TIDAK di-retry — itu jawaban
 * server yang sah. Gagal jaringan (fetch throw, termasuk AbortError
 * karena timeout) dilempar ke pemanggil, yang WAJIB menampilkannya,
 * jangan ditelan diam-diam.
 */
export async function apiFetchResilient(
  path: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const primary = await getServerUrl();
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const base = normalizeBaseUrl(primary);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like apiJson, but over apiFetchResilient (timeout).
 * 401 → null; non-2xx lain → ApiError; gagal parse JSON → null.
 * Gagal jaringan → throw (pemanggil wajib menampilkannya,
 * jangan ditelan diam-diam).
 */
export async function apiJsonResilient<T>(
  path: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<T | null> {
  const res = await apiFetchResilient(path, timeoutMs, init);
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new ApiError(res.status, await errorText(res));
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function postJsonResilient(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return apiFetchResilient(path, timeoutMs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Like apiFetch, but a 401 yields null instead of an error body —
 * so an unsaved token never renders as empty data. Network errors
 * still throw; other non-2xx statuses throw ApiError carrying the
 * server's `error` string when present.
 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await apiFetch(path, init);
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new ApiError(res.status, await errorText(res));
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    /* not JSON — fall through to the status text */
  }
  return `Server returned HTTP ${res.status}`;
}

function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/health — full report, or null when the server answers 401. */
export async function getHealth(): Promise<HealthReport | null> {
  return apiJson<HealthReport>('/api/health');
}

/**
 * Online/offline probe for the server (0.10.6: reachability, BUKAN
 * level kesehatan). true bila server menjawab /api/health dalam 5
 * dtk dengan JSON yang bisa dibaca — level APA PUN, termasuk "bad".
 * Level "bad" (mis. "no valid characters" setelah semua bot dihapus)
 * berarti server hidup tapi ada core check yang gagal, BUKAN server
 * tidak terjangkau; pemakai fungsi ini (Home, Settings) memakainya
 * sebagai penanda "server terjangkau". false hanya bila tidak ada
 * jawaban: error jaringan, timeout, HTTP non-2xx, atau JSON rusak.
 * Detail level tetap tersedia lewat getHealth().
 */
export async function checkHealth(): Promise<boolean> {
  // Retry 3x (perbaikan 31 Okt 2026): saat app dibuka ulang, WiFi HP
  // sering belum stabil (pindah pita 2.4/5 GHz) sehingga probe pertama
  // gagal padahal server hidup — jangan langsung merah. Jeda 1,2 dtk
  // antar percobaan; false hanya bila ketiganya gagal.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const base = await getServerUrl();
      const headers = await authHeaders();
      const res = await fetch(`${base}/api/health`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) continue;
      await res.json();
      return true;
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/** GET /api/characters — null on 401 (token needed).
 * 0.10.13: lewat apiJsonResilient (timeout)
 * seperti getChat — sebelumnya apiJson tanpa timeout: bila gagal
 * menggantung, mount ChatScreen macet dan roomIdFor jatuh ke 'general'
 * sehingga Sam melihat chat kosong (dianggap hilang). */
export async function getCharacters(): Promise<Character[] | null> {
  const data = await apiJsonResilient<{ characters: Character[] }>(
    '/api/characters',
    CHAT_TIMEOUT_MS,
  );
  return data ? data.characters : null;
}

/** GET /api/rooms — null on 401 (token needed).
 * 0.10.13: resilient seperti getCharacters (alasan sama). */
export async function getRooms(): Promise<Room[] | null> {
  const data = await apiJsonResilient<{
    rooms: Room[];
    meeting_budget: number;
    mock_label: string;
  }>('/api/rooms', CHAT_TIMEOUT_MS);
  return data ? data.rooms : null;
}

/**
 * GET /api/chat?room=<id> — null on 401 (token needed).
 * 0.10.12: lewat apiJsonResilient (timeout)
 * supaya gagal jaringan tidak menggantung dan tidak diam-diam kosong.
 */
export async function getChat(room: string): Promise<{ room: string; messages: ChatMessage[] } | null> {
  return apiJsonResilient<{ room: string; messages: ChatMessage[] }>(
    `/api/chat?room=${encodeURIComponent(room)}`,
    CHAT_TIMEOUT_MS,
  );
}

/**
 * POST /api/chat — mock reply path. Persists the user message and
 * returns the server's assistant reply. Throws ApiError on 400
 * (invalid character / empty text / unknown room) and on 429 (daily
 * cap reached — the server gates this itself).
 */
export async function sendMockChat(
  room: string,
  character: string,
  text: string,
  vision = false,
): Promise<MockChatResponse | null> {
  const res = await postJson('/api/chat', { room, character, text, vision });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as MockChatResponse;
}

/**
 * POST /api/messages — persist path used after a BYO model call.
 * Stores one finished message (user or assistant). Accepts NO
 * credential of any kind — only room / character / text / role.
 * Throws ApiError on 400/429 (e.g. meeting-room circuit breaker).
 * 0.10.12: lewat postJsonResilient (timeout).
 * Gagal jaringan di kedua URL → throw; pemanggil (ChatScreen) WAJIB
 * menampilkan peringatan ke user, jangan menelan diam-diam.
 */
/** Video-parity Tahap 1: field delegasi opsional untuk persistMessage. */
export interface PersistMessageDelegation {
  kind?: 'message' | 'delegation';
  target_character?: string;
  created_by?: string;
  source_message_id?: number | string;
}

export async function persistMessage(
  room: string,
  character: string | null,
  text: string,
  role: 'user' | 'assistant',
  replyTo?: string,
  delegation?: PersistMessageDelegation,
): Promise<PersistMessageResponse | null> {
  const body: Record<string, unknown> = { room, character, text, role };
  if (replyTo) body.reply_to = replyTo;
  if (delegation?.kind) body.kind = delegation.kind;
  if (delegation?.target_character) body.target_character = delegation.target_character;
  if (delegation?.created_by) body.created_by = delegation.created_by;
  if (delegation?.source_message_id !== undefined) {
    body.source_message_id = delegation.source_message_id;
  }
  const res = await postJsonResilient('/api/messages', body, CHAT_TIMEOUT_MS);
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as PersistMessageResponse;
}

/**
 * persistMessage dengan retry (0.10.14, Issue 3).
 * Jaringan emulator/HP ke server kadang blip sesaat (terbukti: balasan
 * bot hilang karena persist gagal sekali saat server sempat tidak
 * terjangkau, lalu teks lokal ikut terbuang saat layar di-reload).
 * Balasan asisten adalah hasil kerja bot — jangan hilang karena satu
 * kegagalan transient. Coba sampai 3x (jeda 1 dtk); bila semua gagal,
 * kembalikan null (pemanggil menampilkan banner seperti biasa).
 */
export async function persistMessageWithRetry(
  room: string,
  character: string | null,
  text: string,
  role: 'user' | 'assistant',
  replyTo?: string,
): Promise<PersistMessageResponse | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const saved = await persistMessage(room, character, text, role, replyTo);
      return saved;
    } catch (e) {
      lastError = e;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastError;
}

export interface DelegationRecord {
  id: number;
  target: string;
  target_name: string;
  target_room: string;
  chief_id: string | null;
  chief_room: string | null;
  message: string;
  intent: string;
  delivery_key: string | null;
  status: 'queued' | 'claimed' | 'done' | 'failed';
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
}

/** Fase 7: delegasi sebagai record server (bukan cuma pesan chat). */
export async function createDelegation(input: {
  target: string;
  message: string;
  intent?: string;
  chief_id?: string | null;
  chief_room_id?: string | null;
  delivery_key?: string;
}): Promise<
  | { ok: true; delegation: DelegationRecord; replayed?: boolean }
  | { ok: false; error: string }
  | null
> {
  const res = await postJsonResilient('/api/delegations', input, CHAT_TIMEOUT_MS);
  if (res.status === 401) return null;
  if (!res.ok) return { ok: false, error: await errorText(res) };
  const json = (await res.json()) as {
    delegation?: DelegationRecord;
    delegations?: DelegationRecord[];
    replayed?: boolean | boolean[];
  };
  const first = (json.delegations ?? [])[0] ?? json.delegation;
  if (!first) return { ok: false, error: 'server tidak mengembalikan record delegasi' };
  const rep = Array.isArray(json.replayed) ? json.replayed[0] : json.replayed;
  return { ok: true, delegation: first, replayed: rep };
}

/**
 * POST /api/delegations multi-target (Fase 8): satu panggilan,
 * server memvalidasi SEMUA target dulu (atomik) lalu membuat
 * satu record per target. Desain diadaptasi dari pola delegasi
 * (Apache-2.0); atribusi hanya di komentar ini, bukan UI.
 */
export async function createDelegations(input: {
  targets: string[];
  message: string;
  intent?: string;
  chief_id?: string | null;
  chief_room_id?: string | null;
  delivery_key?: string;
}): Promise<
  | { ok: true; delegations: DelegationRecord[]; replayed: boolean[] }
  | { ok: false; error: string }
  | null
> {
  const res = await postJsonResilient('/api/delegations', input, CHAT_TIMEOUT_MS);
  if (res.status === 401) return null;
  if (!res.ok) return { ok: false, error: await errorText(res) };
  const json = (await res.json()) as {
    delegations?: DelegationRecord[];
    delegation?: DelegationRecord;
    replayed?: boolean | boolean[];
  };
  const list = json.delegations ?? (json.delegation ? [json.delegation] : []);
  const rep: boolean[] = Array.isArray(json.replayed)
    ? json.replayed
    : list.map(() => (typeof json.replayed === 'boolean' ? json.replayed : false));
  return { ok: true, delegations: list, replayed: rep };
}

export async function getDelegations(
  status: string,
): Promise<DelegationRecord[] | null> {
  const data = await apiJson<{ delegations: DelegationRecord[] }>(
    `/api/delegations?status=${encodeURIComponent(status)}`,
  );
  return data ? data.delegations : null;
}

export async function claimDelegation(
  id: number,
): Promise<DelegationRecord | null> {
  const res = await postJsonResilient(
    `/api/delegations/${id}/claim`,
    {},
    CHAT_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { delegation: DelegationRecord };
  return json.delegation;
}

export async function completeDelegation(
  id: number,
  result?: string,
  error?: string,
): Promise<boolean> {
  const res = await postJsonResilient(
    `/api/delegations/${id}/complete`,
    error ? { error } : { result: result ?? '' },
    CHAT_TIMEOUT_MS,
  );
  return res.ok;
}

/**
 * POST /api/characters — create a new bot. `focus` is required and
 * must be one of the FOCUS_DEFAULTS keys; `role` / `skills` fall back
 * to the focus defaults on the server. Throws ApiError 409 when a
 * bot file with the same slug already exists.
 */
export async function createCharacter(input: {
  name: string;
  focus: CharacterFocus;
  role?: string;
  skills?: string[];
  /** Video-parity Tahap 1: Chief pembuat bot (untuk "Created by"). */
  created_by?: string;
}): Promise<Character | null> {
  // 0.10.9: normalisasi fokus di boundary API — server hanya terima
  // kode Inggris; label Indonesia ("sehari-hari" dsb.) dipetakan dulu.
  const body: Record<string, unknown> = { name: input.name, focus: focusCodeFor(input.focus) };
  if (input.role !== undefined) body.role = input.role;
  if (input.skills !== undefined) body.skills = input.skills;
  if (input.created_by !== undefined) body.created_by = input.created_by;
  const res = await postJson('/api/characters', body);
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  const data = (await res.json()) as { character: Character };
  return data.character;
}

/**
 * GET /api/skills — null on 401 (token needed).
 */
export async function getSkills(): Promise<SkillInfo[] | null> {
  const data = await apiJson<{ skills: SkillInfo[] }>('/api/skills');
  return data ? data.skills : null;
}

/**
 * POST /api/skills — create a skill on the shelf (0.10.10 skill
 * creator). The server validates first (frontmatter + lint) and
 * rejects (ApiError 400) or 409s on a duplicate name — a rejected
 * skill is never written. Returns the created skill + any advisory
 * warnings. Null on 401 (token needed).
 */
export async function createSkill(input: {
  name: string;
  description: string;
  body: string;
  version?: string;
  tags?: string[];
  category?: string;
}): Promise<{ skill: SkillInfo; warnings: string[] } | null> {
  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    body: input.body,
  };
  if (input.version !== undefined) body.version = input.version;
  if (input.tags !== undefined) body.tags = input.tags;
  if (input.category !== undefined) body.category = input.category;
  const res = await postJson('/api/skills', body);
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as { skill: SkillInfo; warnings: string[] };
}

/**
 * POST /api/characters/:id/skills — assign (or remove) a shelf
 * skill on a bot (0.10.10). Returns the updated character + changed
 * flag + note. Throws ApiError 400 (unknown skill / invalid) or 404
 * (unknown bot). Null on 401 (token needed).
 */
export async function assignSkill(
  botId: string,
  skill: string,
  action: 'assign' | 'remove' = 'assign',
): Promise<{ character: Character; changed: boolean; note: string } | null> {
  const res = await postJson(`/api/characters/${encodeURIComponent(botId)}/skills`, {
    skill,
    action,
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as { character: Character; changed: boolean; note: string };
}

/**
 * DELETE /api/characters/:id — delete a bot. `withMemory` also
 * wipes the bot's private memory scope (server: ?with_memory=true).
 *
 * CATATAN 0.9.6: server SUDAH punya endpoint ini (ditambahkan
 * 2026-10-26 di PC: do_DELETE di app/server.py + forget_scope di
 * memory/store.py; mengembalikan {deleted, with_memory}). Di 0.9.4
 * endpoint ini belum ada (HTTP 501) — itulah yang membuat bot yang
 * dihapus "kembali lagi": hapus tidak pernah terjadi di server,
 * jadi refetch daftar bot di Home memunculkannya lagi. Sekarang
 * hapus yang sukses di server berarti bot hilang permanen; hapus
 * yang gagal (throw) berarti bot TETAP ada — pemanggil dilarang
 * menghapus bot dari daftar lokal sebelum server mengonfirmasi.
 *
 * CATATAN 0.9.6 (permintaan Sam: data bot lama keluar lagi setelah
 * hapus + buat bot baru): server diminta JUGA menghapus pesan-pesan
 * bot itu dari chat.json saat DELETE (spesifikasi di
 * BUILD-0.9.6-HANDOFF.md) — pilihan with_memory hanya mengatur
 * memory.db, bukan pesan chat. Sampai server mengimplementasikannya,
 * aplikasi melindungi dari sisi lain: bot baru langsung dibuatkan
 * room 1-1 sendiri (api/botChat.createBotChat) supaya chat-nya
 * mulai kosong dan tidak jatuh ke "general" yang masih menyimpan
 * pesan lama.
 * Returns false on 401 (token needed); throws ApiError otherwise.
 */
export async function deleteCharacter(id: string, withMemory = false): Promise<boolean> {
  const res = await apiFetch(
    `/api/characters/${encodeURIComponent(id)}?with_memory=${withMemory ? 'true' : 'false'}`,
    { method: 'DELETE' },
  );
  if (res.status === 401) return false;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return true;
}

/**
 * DELETE /api/rooms/:id — delete a chat room (0.9.5, permintaan Sam:
 * "tidak ada hapus chat").
 *
 * CATATAN 0.9.6: server SUDAH punya endpoint ini (ditambahkan
 * 2026-10-26 di PC: do_DELETE di app/server.py + delete_room di
 * app/chat_store.py; mengembalikan {deleted}; menolak room default
 * general/meeting-room dengan 400, id tak dikenal dengan 404).
 * Returns false on 401 (token needed); throws ApiError otherwise.
 */
export async function deleteRoom(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/rooms/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return true;
}

/**
 * POST /api/rooms — create a room/group/space. The server field is
 * `mode` ("chat" | "meeting" | "space"); members that are not valid
 * characters are dropped by the server. Mode "space" (0.10.0) is a
 * named workspace that groups bots by topic.
 */
export async function createRoom(input: {
  name: string;
  members?: string[];
  mode?: 'chat' | 'meeting' | 'space';
  /** Video-parity Tahap 1: siapa yang membuat room ini. */
  created_by?: string;
}): Promise<Room | null> {
  const body: Record<string, unknown> = {
    name: input.name,
    members: input.members ?? [],
    mode: input.mode ?? 'chat',
  };
  if (input.created_by !== undefined) body.created_by = input.created_by;
  const res = await postJson('/api/rooms', body);
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  const data = (await res.json()) as { room: Room };
  return data.room;
}

/** GET /api/memory?character=<id> — null on 401 (token needed) or 404. */
export async function getMemory(
  character: string,
): Promise<{ character: string; scopes: string[]; memories: MemoryEntry[] } | null> {
  const data = await apiJson<{
    character: string;
    scopes: string[];
    memories: MemoryEntry[];
  }>(`/api/memory?character=${encodeURIComponent(character)}`);
  return data;
}

/** POST /api/memory — save one memory line for a character. */
export async function saveMemory(
  character: string,
  text: string,
): Promise<SaveMemoryResponse | null> {
  const res = await postJson('/api/memory', { character, text });
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as SaveMemoryResponse;
}

/**
 * GET /api/costs/cap-check?bot=<id> — the pre-flight gate.
 * Throws ApiError on 400 (bot missing). Network failure is NOT
 * swallowed here — use checkCapOrAllow() for the fail-open variant.
 */
export async function checkCap(bot: string): Promise<CapCheck> {
  const data = await apiJson<CapCheck>(
    `/api/costs/cap-check?bot=${encodeURIComponent(bot)}`,
  );
  if (data === null) {
    // 401: the token gate, not a cap answer — treat as "no gate data".
    throw new ApiError(401, 'Server answered 401 — save its access token first.');
  }
  return data;
}

/**
 * Fail-open wrapper around checkCap(), mirroring the web deck:
 * when the ledger is down or unreachable, do NOT block the task
 * (the server still enforces the cap on POST /api/chat itself).
 * Returns { allowed: true } with no cap data in that case.
 */
export async function checkCapOrAllow(bot: string): Promise<CapCheck> {
  try {
    return await checkCap(bot);
  } catch {
    return {
      bot,
      day: '',
      cap_usd: null,
      spent_usd: 0,
      remaining_usd: null,
      allowed: true,
      message: 'cap-check unreachable — proceeding, server still gates',
    };
  }
}

/**
 * POST /api/costs/record — report usage AFTER a provider call.
 * Only numbers + model name + bot/task ids are sent, exactly as the
 * web deck's reportUsage(). No usage, no call (returns null).
 * Never throws for a failed ledger — a ledger failure must not fail
 * the chat. Returns the recorded record, or null.
 */
export async function recordCost(input: {
  bot: string;
  taskId: string;
  taskKind?: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
}): Promise<CostRecord | null> {
  if (!input.usage) return null;
  try {
    const res = await postJson('/api/costs/record', {
      bot: input.bot,
      task_id: input.taskId,
      task_kind: input.taskKind ?? 'chat',
      model: input.model,
      prompt_tokens: input.usage.prompt_tokens ?? 0,
      completion_tokens: input.usage.completion_tokens ?? 0,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { record: CostRecord };
    return data.record ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/costs/record dengan usage_available=false —
 * penanda eksplisit 'biaya tidak terukur' (Fase 4b). Dipakai
 * bila provider streaming tidak mengirim usage (Mercury).
 * TIDAK mengirim angka token apa pun: nol palsu dilarang.
 * Best-effort seperti recordCost (null bila gagal).
 */
export async function recordUnmeasuredCost(input: {
  bot: string;
  taskId: string;
  taskKind?: string;
  model: string;
}): Promise<CostRecord | null> {
  try {
    const res = await postJson('/api/costs/record', {
      bot: input.bot,
      task_id: input.taskId,
      task_kind: input.taskKind ?? 'chat',
      model: input.model,
      usage_available: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { record: CostRecord };
    return data.record ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/stop — stop replies in a room. Returns true when the
 * server recorded the stop. Throws ApiError on 400 (unknown room).
 */
export async function stopRoom(room: string): Promise<boolean> {
  const res = await postJson('/api/stop', { room });
  if (res.status === 401) return false;
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return true;
}

/**
 * Langkah 2 fase 3 — turn server (dipakai app bila server mendukung).
 *
 * Probe kapabilitas: GET /api/turns mengembalikan 200 di server baru,
 * 404 di server lama — app yang tidak kenal turn server tetap memakai
 * loop in-app. Semua fungsi ini melempar ApiError untuk status
 * non-2xx (kecuali probe yang mengembalikan boolean).
 */
export async function probeServerTurns(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/turns');
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitServerTurn(input: {
  room: string;
  character: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
}): Promise<{ turn: ServerTurn; user_message: ChatMessage; replayed?: boolean }> {
  const body: Record<string, unknown> = {
    room: input.room,
    character: input.character,
    text: input.text,
  };
  if (input.replyTo) body.reply_to = input.replyTo;
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
  const res = await postJson('/api/turns', body);
  if (res.status === 401) {
    throw new ApiError(401, 'Server menjawab 401 — simpan access token dulu.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as {
    turn: ServerTurn;
    user_message: ChatMessage;
    replayed?: boolean;
  };
}

export async function getServerTurns(
  room?: string,
  status?: string,
): Promise<ServerTurn[]> {
  const q = new URLSearchParams();
  if (room) q.set('room', room);
  if (status) q.set('status', status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  const data = await apiJson<{ turns: ServerTurn[] }>(`/api/turns${suffix}`);
  return data?.turns ?? [];
}

/** Turn aktif (queued/running) pertama di room, atau null bila tidak ada. */
export async function getActiveServerTurn(room: string): Promise<ServerTurn | null> {
  const [queued, running] = await Promise.all([
    getServerTurns(room, 'queued'),
    getServerTurns(room, 'running'),
  ]);
  const all = [...queued, ...running].sort((a, b) => a.id - b.id);
  return all[0] ?? null;
}

/** Apakah runner server melapor hidup & segar (< 90 dtk)? */
export async function probeRunnerPresence(): Promise<boolean> {
  try {
    const data = await apiJson<{ present: boolean }>('/api/runner/presence');
    return !!data?.present;
  } catch {
    return false;
  }
}
