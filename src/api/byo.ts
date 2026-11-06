/**
 * BYO-API: call the user's own model provider DIRECTLY from the app.
 *
 * HARD INVARIANT (same as the web deck): the credential lives ONLY
 * in expo-secure-store under "grokbot_byo" and is sent ONLY as
 * `Authorization: Bearer <credential>` to the provider's own base
 * URL (baseUrl + "/chat/completions"). The local server NEVER
 * receives, stores, or sees the credential — there is no server
 * endpoint that accepts one.
 *
 * Streaming: React Native's fetch() does not expose a readable
 * response body, so SSE streaming is done with XMLHttpRequest
 * (onprogress + incremental responseText parsing). The request can
 * be aborted with an AbortSignal. A provider that rejects
 * stream:true (400/404/422) is retried once with stream:false.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ByoConfig, CapCheck, TokenUsage } from './types';
import { checkCap } from './client';

export const BYO_STORE_KEY = 'grokbot_byo';
export const DEFAULT_BYO_MODEL = 'gpt-4o-mini';

/**
 * Flag AsyncStorage — BYO pernah berhasil disimpan (0.10.13).
 *
 * Dipakai untuk membedakan "BYO belum pernah dikonfigurasi"
 * (mock adalah fallback yang sah) dari "BYO pernah ada tapi kini
 * tidak terbaca" (SecureStore gagal / config hilang — HARUS
 * tampil error jelas, bukan diam-diam MOCK). Flag ini hidup di
 * AsyncStorage (terpisah dari SecureStore) supaya tetap bisa
 * dibaca walau SecureStore-nya sendiri yang bermasalah.
 */
const BYO_CONFIGURED_KEY = 'grokbot_byo_configured';

/** Tandai BYO pernah dikonfigurasi (dipanggil saveByo setelah sukses). */
export async function markByoConfigured(): Promise<void> {
  try {
    await AsyncStorage.setItem(BYO_CONFIGURED_KEY, '1');
  } catch {
    // Flag hanya diagnostik — gagal simpan tidak menggagalkan BYO.
  }
}

/** Apakah BYO pernah berhasil dikonfigurasi di HP ini? */
export async function wasByoEverConfigured(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(BYO_CONFIGURED_KEY)) === '1';
  } catch {
    return false;
  }
}

/** Timeout panggilan model (0.10.13): request yang macet tidak boleh gantung selamanya. */
export const BYO_XHR_TIMEOUT_MS = 300000;

/** Error thrown when the daily-cap gate refuses a new task. */
export class CapBlockedError extends Error {
  readonly capCheck: CapCheck;

  constructor(capCheck: CapCheck) {
    super(capCheck.message || 'Cap harian tercapai.');
    this.name = 'CapBlockedError';
    this.capCheck = capCheck;
  }
}

export async function getByo(): Promise<ByoConfig | null> {
  const raw = await SecureStore.getItemAsync(BYO_STORE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ByoConfig>;
    if (
      typeof parsed.baseUrl !== 'string' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.credential !== 'string'
    ) {
      return null;
    }
    return {
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      // Credential yang tersimpan sebelum 0.9.4 bisa membawa spasi /
      // newline dari paste (file teks di HP) — trim di load agar
      // kredensial lama langsung jalan tanpa isi ulang. (0.9.4: dulu
      // "Bearer <key>\n" ditolak router dengan HTTP 401.)
      credential: parsed.credential.trim(),
    };
  } catch {
    return null;
  }
}

export async function saveByo(cfg: ByoConfig): Promise<void> {
  const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
  const model = cfg.model.trim();
  // Trim kredensial: paste dari file teks di HP sering membawa newline
  // di akhir, dan "Bearer <key>\n" ditolak provider dengan HTTP 401.
  const credential = cfg.credential.trim();
  if (!baseUrl) throw new Error('BYO base URL must not be empty.');
  if (!model) throw new Error('BYO model must not be empty.');
  if (!credential) throw new Error('BYO credential must not be empty.');
  await SecureStore.setItemAsync(
    BYO_STORE_KEY,
    JSON.stringify({ baseUrl, model, credential }),
  );
  // 0.10.13: tandai BYO pernah dikonfigurasi — supaya bila nanti
  // SecureStore tidak terbaca, app tahu ini kehilangan config
  // (tampilkan error jelas) bukan "belum pernah setup" (mock).
  await markByoConfigured();
}

export async function clearByo(): Promise<void> {
  await SecureStore.deleteItemAsync(BYO_STORE_KEY);
}

export function isByoConfigured(cfg: ByoConfig | null | undefined): boolean {
  return Boolean(cfg && cfg.baseUrl && cfg.credential);
}

/** A content part for a chat message (text, or a vision image URL). */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatContent = string | ChatContentPart[];

/** One chat message (system, user, assistant, or tool result) in an OpenAI-style request. */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  /** Tool calls made by an assistant message (OpenAI shape). */
  tool_calls?: ChatToolCall[];
  /** Which tool call this tool message answers. */
  tool_call_id?: string;
};

/** One tool definition, OpenAI function-calling shape. */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** One tool call as returned by the model (OpenAI shape). */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A tool call with its JSON arguments parsed (best effort). */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsRaw: string;
  argsValid: boolean;
}

/** Parse a raw tool call's JSON arguments (never throws). */
export function parseToolCallArgs(call: ChatToolCall): ParsedToolCall {
  const raw = call.function?.arguments ?? '';
  let args: Record<string, unknown> = {};
  let valid = true;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    } else {
      valid = false;
    }
  } catch {
    valid = false;
  }
  return {
    id: call.id,
    name: call.function?.name ?? '',
    args,
    argsRaw: raw,
    argsValid: valid,
  };
}

/**
 * Batas riwayat chat yang dikirim ke model per turn (0.10.5, perbaikan
 * "pikun"): 20 pesan terakhir. Tanpa batas, token meledak pada room
 * panjang; 20 turn cukup untuk konteks percakapan normal.
 */
export const MAX_CHAT_HISTORY_MESSAGES = 20;

/**
 * Prefix balasan demo server (MOCK) — "…demo reply, no real API call".
 * Balasan ini BUKAN jawaban model nyata; bila ikut terkirim sebagai
 * riwayat, model meniru formatnya (terbukti di emulator 0.10.5: turn
 * "Iya gas" dijawab model hanya dengan label MOCK itu). Disaring dari
 * riwayat — pesan aslinya tetap tersimpan di server & tampil di UI.
 */
export const MOCK_REPLY_PREFIX = '[MOCK model';

/** True bila teks adalah balasan demo server (bukan jawaban model nyata). */
export function isMockReplyText(text: string): boolean {
  return text.trim().startsWith(MOCK_REPLY_PREFIX);
}

/**
 * Ambil riwayat yang layak dikirim ke model: hanya pesan user/assistant
 * dengan isi non-kosong, urutan kronologis dipertahankan, dibatasi ke
 * N pesan terakhir. Pesan system/tool TIDAK ikut — system prompt
 * dikirim terpisah sebagai pesan pertama, pesan tool hanya hidup di
 * dalam putaran tool loop. Balasan demo server (MOCK) juga disaring:
 * itu artefak demo, bukan percakapan — model meniru formatnya bila
 * ikut terkirim (lihat MOCK_REPLY_PREFIX).
 */
export function takeRecentHistory(
  history: ChatMessage[] | null | undefined,
  maxMessages: number = MAX_CHAT_HISTORY_MESSAGES,
): ChatMessage[] {
  if (!history || history.length === 0) return [];
  const limit = Math.max(0, Math.floor(maxMessages));
  if (limit === 0) return [];
  const usable = history.filter((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (typeof m.content === 'string') {
      const t = m.content.trim();
      return t.length > 0 && !isMockReplyText(t);
    }
    return Array.isArray(m.content) && m.content.length > 0;
  });
  return usable.slice(-limit);
}

/**
 * Build the OpenAI-style messages array for one user turn.
 * 0.9.8: `systemPrompt` (opsional) ditaruh sebagai pesan pertama
 * ({role:'system'}) sebelum pesan user — tanpa itu, perilaku lama
 * tetap (hanya pesan user) supaya pemakaian lain tidak berubah.
 * 0.10.5: `history` (opsional) — turn-turn sebelumnya, disisipkan
 * antara system prompt dan pesan user saat ini, supaya model ingat
 * konteks ("Iya legal" = jawaban, bukan kata untuk didefinisikan).
 * Tanpa history, output sama persis seperti sebelumnya.
 */
export function buildChatMessages(
  content: ChatContent,
  systemPrompt?: string | null,
  history?: ChatMessage[] | null,
): ChatMessage[] {
  const system = (systemPrompt || '').trim();
  const out: ChatMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  out.push(...takeRecentHistory(history));
  out.push({ role: 'user', content });
  return out;
}

/** Build the /chat/completions request body from a message list. */
export function buildCompletionsBodyFromMessages(
  cfg: ByoConfig,
  messages: ChatMessage[],
  stream: boolean,
  tools?: ChatTool[] | null,
): {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: ChatTool[];
} {
  const body: {
    model: string;
    messages: ChatMessage[];
    stream: boolean;
    tools?: ChatTool[];
  } = {
    model: cfg.model || DEFAULT_BYO_MODEL,
    messages,
    stream,
  };
  if (tools && tools.length > 0) body.tools = tools;
  return body;
}

/** Build the /chat/completions request body. */
export function buildCompletionsBody(
  cfg: ByoConfig,
  content: ChatContent,
  stream: boolean,
  systemPrompt?: string | null,
  tools?: ChatTool[] | null,
  history?: ChatMessage[] | null,
): {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: ChatTool[];
} {
  return buildCompletionsBodyFromMessages(
    cfg,
    buildChatMessages(content, systemPrompt, history),
    stream,
    tools,
  );
}

/** Extract the assistant text from a non-streamed completions response. */
export function extractReplyText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/**
 * Hapus blok penalaran <think>...</think> dari teks balasan (0.10.5):
 * model turunan DeepSeek kadang membocorkan tag think ke jawaban
 * ("Siap, OK! ... </think> ..." terlihat di chat 26 Okt 17:20 UTC).
 * Dipakai untuk teks yang ditampilkan/disimpan; isi di dalam blok
 * think tidak pernah ditampilkan. Blok yang belum tertutup dihapus
 * sampai akhir teks (streaming parsial), dan tag stray </think>
 * ikut dibuang. Teks tanpa think tidak berubah.
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract tool calls from a non-streamed completions response (0.9.9). */
export function extractToolCalls(data: unknown): ChatToolCall[] {
  if (!data || typeof data !== 'object') return [];
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return [];
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: ChatToolCall[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const fn = (c as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') continue;
    out.push({
      id: typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : '',
      type: 'function',
      function: {
        name: typeof (fn as { name?: unknown }).name === 'string' ? (fn as { name: string }).name : '',
        arguments:
          typeof (fn as { arguments?: unknown }).arguments === 'string'
            ? (fn as { arguments: string }).arguments
            : '',
      },
    });
  }
  return out;
}

/** Extract finish_reason from a non-streamed completions response (0.9.9). */
export function extractFinishReason(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return null;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' ? reason : null;
}

export function extractUsage(data: unknown): TokenUsage | null {
  if (!data || typeof data !== 'object') return null;
  const usage = (data as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage as TokenUsage;
}

/**
 * Incremental SSE parser. Feed it raw text chunks as they arrive
 * (e.g. from XHR onprogress); it buffers partial lines and emits
 * completed deltas via onDelta(fullTextSoFar). Malformed `data:`
 * lines are ignored, exactly like the web deck. `[DONE]` ends the
 * stream. `usage` is captured when a chunk carries it.
 */
export class SseStreamParser {
  private buf = '';
  text = '';
  usage: TokenUsage | null = null;
  done = false;
  /** Tool calls streamed so far: merged by index when the provider
   * sends fragments (OpenAI), kept separate when it sends complete
   * calls without an index (d4f_wrapper) — 0.10.7. */
  toolCalls: ChatToolCall[] = [];
  /** finish_reason of the last choice seen (e.g. 'tool_calls'), if any. */
  finishReason: string | null = null;

  feed(chunk: string, onDelta?: (fullText: string) => void): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line, onDelta);
      if (this.done) break;
    }
  }

  private handleLine(line: string, onDelta?: (fullText: string) => void): void {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      this.done = true;
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // ignore a malformed SSE line
    }
    if (!parsed || typeof parsed !== 'object') return;
    const obj = parsed as {
      usage?: TokenUsage;
      choices?: Array<{
        delta?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }>;
    };
    if (obj.usage) this.usage = obj.usage;
    const choice = obj.choices?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string') {
      this.finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      this.text += delta.content;
      onDelta?.(this.text);
    }
    // Streamed tool calls arrive as fragments per index: id/name
    // once, then function.arguments in pieces. Merge by index.
    // 0.10.7: d4f_wrapper mengirim calls LENGKAP dalam satu delta TANPA
    // `index` (satu chunk SSE berisi semua tool_calls). Dua calls tanpa
    // index JANGAN digabung ke slot 0 — arguments-nya ter-concat jadi
    // JSON tidak valid ("{...}{...}"), parseToolCallArgs gagal, vm_exec
    // tidak pernah POST, model mengulang call yang sama sampai batas
    // putaran. Karena itu: ada index -> gabung per index (ala OpenAI);
    // tanpa index -> gabung hanya bila id sama (call yang sama terkirim
    // terpotong), id berbeda -> slot baru.
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as {
          index?: unknown;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        let slot: ChatToolCall | undefined;
        if (typeof entry.index === 'number') {
          slot = this.toolCalls[entry.index];
          if (!slot) {
            slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
            this.toolCalls[entry.index] = slot;
          }
        } else if (typeof entry.id === 'string' && entry.id) {
          slot = this.toolCalls.find((c) => c.id === entry.id);
          if (!slot) {
            slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
            this.toolCalls.push(slot);
          }
        } else {
          slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
          this.toolCalls.push(slot);
        }
        if (typeof entry.id === 'string' && entry.id) slot.id = entry.id;
        if (entry.function) {
          if (typeof entry.function.name === 'string' && entry.function.name) {
            slot.function.name = entry.function.name;
          }
          if (typeof entry.function.arguments === 'string') {
            slot.function.arguments += entry.function.arguments;
          }
        }
      }
    }
  }
}

export interface ByoReply {
  /** true when the provider answered SSE (or the stream flag was honoured). */
  streamed: boolean;
  /** Full assistant text (streamed deltas joined, or extracted from JSON). */
  text: string;
  /** Raw non-streamed response body, when streamed === false. */
  data?: unknown;
  /** Token usage when the provider reported it. */
  usage?: TokenUsage | null;
  /** Model name as reported by the provider, when present. */
  model?: string;
}

interface XhrResult {
  status: number;
  contentType: string;
  text: string;
}

function abortError(): Error {
  const err = new Error('The request was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * One XHR POST to baseUrl + "/chat/completions". Resolves on load
 * for ANY HTTP status (the caller decides about retries); rejects
 * on network error, timeout, or abort. The credential goes ONLY
 * into the Authorization header of this provider call.
 */
function doXhr(
  cfg: ByoConfig,
  messages: ChatMessage[],
  stream: boolean,
  tools: ChatTool[] | null,
  onDelta: ((fullText: string) => void) | undefined,
  abortSignal?: AbortSignal,
): Promise<XhrResult & { parser?: SseStreamParser }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const parser = new SseStreamParser();
    let seen = 0;
    // Delta yang diteruskan ke UI sudah bersih dari blok <think>
    // (0.10.5) — parser tetap mengakumulasi teks mentah internal.
    const cleanDelta = onDelta
      ? (fullText: string) => onDelta(stripThinkBlocks(fullText))
      : undefined;

    xhr.open('POST', `${cfg.baseUrl}/chat/completions`);
    // 0.10.13: timeout 120 dtk (naik dari 30 dtk, 4 Nov 2026) — request yang macet (provider /
    // jaringan diam) tidak boleh gantung selamanya; handler
    // ontimeout sudah ada, tapi tanpa nilai timeout ia tak pernah
    // jalan (timeout 0 = tanpa batas). Kini gagal cepat dengan
    // pesan 'Model API request timed out.' yang jelas.
    xhr.timeout = BYO_XHR_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${cfg.credential}`);
    try {
      xhr.responseType = 'text';
    } catch {
      /* some environments ignore responseType — responseText still works */
    }

    xhr.onprogress = () => {
      const full = xhr.responseText || '';
      const fresh = full.slice(seen);
      seen = full.length;
      if (fresh) parser.feed(fresh, cleanDelta);
    };
    xhr.onload = () => {
      const full = xhr.responseText || '';
      const fresh = full.slice(seen);
      seen = full.length;
      if (fresh) parser.feed(fresh, cleanDelta);
      settle(() =>
        resolve({
          status: xhr.status,
          contentType: xhr.getResponseHeader('content-type') || '',
          text: full,
          parser,
        }),
      );
    };
    xhr.onerror = () => settle(() => reject(new Error('Model API request failed (network error).')));
    xhr.ontimeout = () => settle(() => reject(new Error('Model API request timed out.')));
    xhr.onabort = () => settle(() => reject(abortError()));

    if (abortSignal) {
      if (abortSignal.aborted) {
        settle(() => reject(abortError()));
        return;
      }
      abortSignal.addEventListener(
        'abort',
        () => {
          try {
            xhr.abort();
          } catch {
            /* already finished */
          }
          settle(() => reject(abortError()));
        },
        { once: true },
      );
    }

    xhr.send(JSON.stringify(buildCompletionsBodyFromMessages(cfg, messages, stream, tools)));
  });
}

const STREAM_RETRY_STATUSES = new Set([400, 404, 422]);

/**
 * Stream a reply from the provider. Returns { streamed: true, text,
 * usage } for SSE, or { streamed: false, data, text, usage } when the
 * provider answers plain JSON (including the one retry with
 * stream:false after a 400/404/422). Throws on HTTP errors and on
 * abort (err.name === 'AbortError'). The credential is used ONLY
 * for the Authorization header of this provider call.
 *
 * `systemPrompt` (0.9.8, opsional) dikirim sebagai pesan pertama
 * ({role:'system'}) — identitas karakter supaya model menjawab
 * sebagai bot itu, bukan chatbot generik.
 *
 * `history` (0.10.5, opsional) — turn-turn sebelumnya, diteruskan
 * ke buildChatMessages supaya model ingat konteks percakapan.
 */
export async function streamByoReply(
  cfg: ByoConfig,
  content: ChatContent,
  onDelta?: (fullText: string) => void,
  abortSignal?: AbortSignal,
  systemPrompt?: string | null,
  history?: ChatMessage[] | null,
): Promise<ByoReply> {
  if (!cfg.baseUrl || !cfg.credential) {
    throw new Error('BYO-API is not configured (need baseUrl and credential).');
  }

  let res = await doXhr(
    cfg,
    buildChatMessages(content, systemPrompt, history),
    true,
    null,
    onDelta,
    abortSignal,
  );
  if (!isOkStatus(res.status) && STREAM_RETRY_STATUSES.has(res.status)) {
    // Provider rejects streaming — retry once without it.
    res = await doXhr(
      cfg,
      buildChatMessages(content, systemPrompt, history),
      false,
      null,
      onDelta,
      abortSignal,
    );
  }
  if (!isOkStatus(res.status)) {
    throw new Error(`Model API returned HTTP ${res.status}`);
  }

  const isSse = res.contentType.toLowerCase().includes('text/event-stream');
  if (isSse) {
    return {
      streamed: true,
      text: stripThinkBlocks(res.parser?.text ?? ''),
      usage: res.parser?.usage ?? null,
    };
  }

  // Plain JSON answer (provider ignored stream:true, or the retry).
  let data: unknown = null;
  try {
    data = res.text ? JSON.parse(res.text) : null;
  } catch {
    data = null;
  }
  const model =
    data && typeof data === 'object' && typeof (data as { model?: unknown }).model === 'string'
      ? (data as { model: string }).model
      : undefined;
  return {
    streamed: false,
    data,
    text: stripThinkBlocks(extractReplyText(data)),
    usage: extractUsage(data),
    model,
  };
}

/** Options for the BYO tool loop (0.9.9). */
export interface ToolLoopOptions {
  /** Tools offered to the model (OpenAI function-calling shape). */
  tools: ChatTool[];
  /** Executes one parsed tool call; returns the result text for the model. */
  execTool: (call: ParsedToolCall) => Promise<string>;
  /** Max model turns (default 5) — the loop never runs forever. */
  maxRounds?: number;
  /** Fired for the final streamed text (same as streamByoReply). */
  onDelta?: (fullText: string) => void;
  /** Fired when the model requests a tool (UI indicator). */
  /** Dipanggil tiap model meminta tool (untuk indikator thinking). `round` = putaran ke-N (1-based) — dipakai indikator untuk menunjukkan progres per putaran (Sam 09:01: cap 20, bot harus kelihatan kerja, bukan bengong). */
  onToolCall?: (call: ParsedToolCall, round?: number) => void;
  abortSignal?: AbortSignal;
  systemPrompt?: string | null;
  /** Turn-turn sebelumnya (0.10.5, perbaikan "pikun") — disisipkan
   * antara system prompt dan pesan user saat ini. */
  history?: ChatMessage[] | null;
}

/** Result of the tool loop: a normal reply plus the calls executed. */
export interface ToolLoopResult extends ByoReply {
  /** Every tool call the model made (in order). */
  toolCalls: ParsedToolCall[];
  /** Model turns used (1 = answered directly, no tool call). */
  rounds: number;
}

// 0.10.7: FULL CAP (Sam 09:12: "buat full cap") — model FREE
// (DeepSeek 4Free, tanpa billing per token), jadi TIDAK ADA batas
// jumlah putaran sebagai penghenti normal. Satu-satunya yang
// menghentikan loop: (a) dedupe — model mengulang call IDENTIK
// persis (stuck, bukan progres) → stop + rangkum; (b) stall —
// tidak ada hasil tool BARU yang sukses selama
// TOOL_LOOP_STALL_ROUNDS ronde berturut-turut → stop + rangkum;
// (c) hard ceiling 100 putaran sebagai jaring pengaman terakhir
// supaya tidak infinite loop selamanya. opts.maxRounds (bila
// diisi pemanggil, mis. tes) tetap dihormati sebagai batas
// eksplisit. Thinking indicator wajib menunjukkan putaran ke-N
// (round) karena tugas bisa jalan lama tanpa cap.
const TOOL_LOOP_HARD_MAX_ROUNDS = 100;
/** Ronde berturut-turut tanpa hasil tool BARU yang sukses → stall. */
const TOOL_LOOP_STALL_ROUNDS = 3;

/**
 * 0.10.7: apakah hasil tool menandakan kegagalan eksekusi (validasi /
 * fetch / HTTP / timeout / tool tidak dikenal). Dipakai loop untuk
 * berhenti retry buta dan memaksa jawaban akhir. String-string ini
 * adalah teks yang dikembalikan eksekutor (sandbox.ts, execTool
 * ChatScreen, MCP) sebagai hasil tool — bukan teks model.
 */
export function isToolFailureResult(result: string): boolean {
  const r = result.trim();
  return (
    (r.startsWith('Argumen ') && r.includes('tidak valid')) ||
    r.startsWith('Perintah tidak dijalankan') ||
    r.startsWith('Perintah gagal dijalankan') ||
    r.startsWith('Tool itu tidak dikenal') ||
    r.startsWith('Gagal:') ||
    r.startsWith('Terjadi error:') ||
    r.startsWith('Aksi itu TIDAK dijalankan') ||
    /^Tool \S+ (gagal|timeout)/.test(r)
  );
}

/**
 * Stream a reply with tool calling (0.9.9, Fase B).
 *
 * Agent loop ala OpenAI: kirim pesan + tools → bila model menjawab
 * tool_calls, eksekusi tiap call lewat `execTool`, kirim hasilnya
 * sebagai pesan tool, dan kirim lagi — sampai model menjawab teks
 * biasa atau maxRounds tercapai. Tanpa tool_calls dari model,
 * perilakunya sama dengan streamByoReply (satu turn).
 *
 * Streaming: delta konten mengalir lewat onDelta seperti biasa;
 * tool_calls yang datang lewat SSE diakumulasi parser (bukan teks).
 * Bila provider tidak mendukung tool (tidak pernah mengembalikan
 * tool_calls), loop berhenti di ronde pertama dengan jawaban teks.
 */
/**
 * fix22 — deteksi tugas browser dari teks pesan user turn ini.
 * Hanya terpicu bila user eksplisit minta buka/browser atau
 * menulis URL — pertanyaan umum tanpa kata itu tidak terpengaruh,
 * supaya chat biasa tidak dipaksa memanggil tool.
 */
function contentToPlainText(content: ChatContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && p.type === 'text' ? p.text : ''))
      .join(' ');
  }
  return '';
}

function isBrowserTaskText(text: string): boolean {
  const t = text.toLowerCase();
  return /\bbuka\b|\bbrowser\b|https?:\/\/|www\./.test(t);
}

function isResearchTaskText(text: string): boolean {
  const t = text.toLowerCase();
  return /\bris(et|earch)\b|data ter(verifikasi|baru|kini)|berita terbaru|tren terbaru|statistik|cari tahu|cek (fakta|harga)|bandingkan\b/.test(t);
}

export async function streamByoReplyWithTools(
  cfg: ByoConfig,
  content: ChatContent,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  if (!cfg.baseUrl || !cfg.credential) {
    throw new Error('BYO-API is not configured (need baseUrl and credential).');
  }
  const maxRounds = opts.maxRounds ?? TOOL_LOOP_HARD_MAX_ROUNDS;
  // fix22: tugas browser turn ini + apakah retry paksa-tool sudah dipakai.
  const browserTask = isBrowserTaskText(contentToPlainText(content));
  let browserRetryUsed = false;
  // Riset spek (jalur tes): tugas riset turn ini + apakah retry paksa-tool sudah dipakai.
  const researchTask = isResearchTaskText(contentToPlainText(content));
  let researchRetryUsed = false;
  const tools = opts.tools && opts.tools.length > 0 ? opts.tools : null;
  let messages = buildChatMessages(content, opts.systemPrompt ?? null, opts.history ?? null);
  const executed: ParsedToolCall[] = [];
  // Riset spek (jalur tes): apakah turn ini sudah memanggil web_search
  // atau sudah mendelegasikan ke bot lain (Chief -> spesialis).
  const hasWebSearch = (): boolean => executed.some((c) => c.name === 'web_search');
  const hasDelegated = (): boolean =>
    executed.some((c) => c.name === 'message_bot' || c.name === 'handoff_to_bot');
  const applyResearchLabel = (t: string): string => {
    if (!researchTask || !t || t.includes('http')) return t;
    if (!hasWebSearch()) return t;
    return (
      t +
      '\n\n[Catatan: jawaban ini belum mengutip URL sumber yang dibuka lewat tool — anggap sebagai ide mentah, bukan data terverifikasi.]'
    );
  };
  let lastText = '';
  let lastUsage: TokenUsage | null = null;
  let lastModel: string | undefined;
  let lastStreamed = false;
  let rounds = 0;

  // 0.10.7 — dedupe + fail-fast (akar "stuck" 07:55):
  // - seenResults: hasil per call identik (nama + args mentah). Model
  //   yang mengulang call yang sama TIDAK dieksekusi ulang (hemat POST
  //   sandbox, hindari efek samping ganda); hasil lama dikembalikan
  //   dari cache.
  // - failedBySignature: berapa kali satu call (nama+args) gagal.
  // - consecutiveFailedRounds / consecutiveRepeatRounds: ronde
  //   berturut-turut yang semua hasilnya gagal / semua call-nya
  //   pengulangan — tanda model terjebak.
  const seenResults = new Map<string, string>();
  const failedBySignature = new Map<string, number>();
  let consecutiveFailedRounds = 0;
  let consecutiveRepeatRounds = 0;
  // 0.10.7 stall (FULL CAP): ronde berturut-turut tanpa hasil tool
  // BARU yang sukses — model tidak berprogres (campuran ulang +
  // gagal yang tidak ditangkap aturan 2-ronde di atas).
  let noProgressRounds = 0;

  // Satu panggilan model TANPA tools untuk memaksa jawaban akhir saat
  // loop harus berhenti (tool gagal berulang / model mengulang call /
  // batas putaran). Bukan retry tool: teks saja yang diambil.
  // 0.10.7: minta RANGKUMAN PARSIAL secara eksplisit — yang sudah
  // terverifikasi (dengan bukti) vs yang belum sempat dicek — JANGAN
  // buang semua hasil dengan "tanyakan lagi".
  const requestFinalAnswer = async (): Promise<string> => {
    const finalMessages: ChatMessage[] = [
      ...messages,
      {
        role: 'user',
        content:
          'Berhenti memanggil tool. Tulis RANGKUMAN dari semua hasil tool yang sudah ada: sebutkan yang sudah terverifikasi (dengan buktinya) dan yang belum sempat dicek. Jangan bilang "tanyakan lagi" dan jangan ulangi tool call.',
      },
    ];
    try {
      const res = await doXhr(cfg, finalMessages, false, null, opts.onDelta, opts.abortSignal);
      if (!isOkStatus(res.status)) return '';
      const isSse = res.contentType.toLowerCase().includes('text/event-stream');
      if (isSse) {
        return stripThinkBlocks(res.parser?.text ?? '').trim();
      }
      let data: unknown = null;
      try {
        data = res.text ? JSON.parse(res.text) : null;
      } catch {
        data = null;
      }
      return stripThinkBlocks(extractReplyText(data)).trim();
    } catch {
      return '';
    }
  };

  // 0.10.7: rangkuman parsial dari hasil tool yang sudah ada — dipakai
  // bila model tidak menjawab panggilan jawaban-akhir (kosong/gagal),
  // supaya cap tercapai TIDAK membuang semua hasil dengan teks
  // fallback generik. Hanya hasil sukses yang dipakai.
  const buildPartialSummary = (): string => {
    const parts: string[] = [];
    for (const [signature, result] of seenResults) {
      if (isToolFailureResult(result)) continue;
      const name = signature.split('\n')[0];
      const oneLine = result.replace(/\s+/g, ' ').trim();
      parts.push(`${name}: ${oneLine.length > 8000 ? `${oneLine.slice(0, 8000)}…` : oneLine}`);
    }
    if (parts.length === 0) return '';
    return (
      'Pemeriksaan sebagian selesai — rangkuman dari hasil tool yang sudah ada:\n' +
      parts.join('\n') +
      '\n(Sebagian belum sempat dicek; tanyakan lagi untuk melanjutkannya.)'
    );
  };

  // Jawaban akhir: utamakan rangkuman model, lalu rangkuman parsial
  // dari hasil tool, terakhir teks generik.
  const finishWithSummary = async (): Promise<string> => {
    // Riset spek: jalur akhir loop juga tidak boleh meloloskan riset
    // tanpa web_search (dan tanpa delegasi).
    if (researchTask && !hasWebSearch() && !hasDelegated()) {
      return 'Riset gagal: saya tidak bisa menjalankan pencarian lewat tool di turn ini, jadi saya tidak mengarang data, tren, atau daftarnya. Coba kirim lagi.';
    }
    const finalText = await requestFinalAnswer();
    if (finalText) return applyResearchLabel(finalText);
    if (lastText) return applyResearchLabel(lastText);
    return buildPartialSummary();
  };

  const buildResult = (text: string): ToolLoopResult => ({
    streamed: lastStreamed,
    text,
    usage: lastUsage,
    model: lastModel,
    toolCalls: executed,
    rounds,
  });

  // FULL CAP (0.10.7): loop jalan sampai model menjawab teks,
  // dedupe/fail-fast menghentikan (stuck), stall 3 ronde tanpa
  // progres, atau hard ceiling 100 putaran. Tidak ada perpanjangan
  // adaptif — cap-nya memang sudah penuh.
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    let res = await doXhr(cfg, messages, true, tools, opts.onDelta, opts.abortSignal);
    if (!isOkStatus(res.status) && STREAM_RETRY_STATUSES.has(res.status)) {
      res = await doXhr(cfg, messages, false, tools, opts.onDelta, opts.abortSignal);
    }
    if (!isOkStatus(res.status)) {
      throw new Error(`Model API returned HTTP ${res.status}`);
    }

    const isSse = res.contentType.toLowerCase().includes('text/event-stream');
    lastStreamed = isSse;
    let text = '';
    let toolCalls: ChatToolCall[] = [];
    let data: unknown = null;
    if (isSse) {
      text = res.parser?.text ?? '';
      toolCalls = (res.parser?.toolCalls ?? []).filter((c) => c.function.name);
      lastUsage = res.parser?.usage ?? null;
    } else {
      try {
        data = res.text ? JSON.parse(res.text) : null;
      } catch {
        data = null;
      }
      text = extractReplyText(data);
      toolCalls = extractToolCalls(data);
      lastUsage = extractUsage(data);
      lastModel =
        data && typeof data === 'object' && typeof (data as { model?: unknown }).model === 'string'
          ? (data as { model: string }).model
          : undefined;
    }
    // Bersihkan blok <think> dari teks putaran ini (0.10.5) — berlaku
    // untuk teks akhir maupun pesan assistant yang dibawa ke putaran
    // tool berikutnya.
    text = stripThinkBlocks(text);
    lastText = text;

    if (toolCalls.length === 0) {
      // fix22 — enforcement tugas browser (proposal A + C):
      // teks tanpa tool call TIDAK BOLEH diterima final di tugas
      // browser, karena itulah halusinasi Leg2 (daftar karangan
      // padahal computer-state tidak bergerak).
      // Riset spek (jalur tes): tugas riset TIDAK BOLEH dijawab tanpa
      // web_search — kecuali turn ini mendelegasikan ke bot riset
      // (Chief), yang gilirannya diwajibkan guard yang sama.
      if (researchTask && !hasWebSearch() && !hasDelegated()) {
        if (!researchRetryUsed) {
          researchRetryUsed = true;
          messages = [
            ...messages,
            {
              role: 'user',
              content:
                'WAJIB: tugas ini adalah tugas riset. Kamu HARUS memanggil tool web_search dulu (lalu web_open untuk membaca sumbernya) sebelum menjawab, atau delegasikan tugas ini ke bot riset. Jangan menjawab dari ingatan. Di jawaban final, kutip URL sumber yang kamu buka. Bila tool gagal, katakan dengan jujur bahwa riset gagal — jangan mengarang data.',
            },
          ];
          continue;
        }
        return {
          streamed: lastStreamed,
          text: 'Riset gagal: saya tidak bisa menjalankan pencarian lewat tool di turn ini, jadi saya tidak mengarang data, tren, atau daftarnya. Coba kirim lagi.',
          usage: lastUsage,
          model: lastModel,
          toolCalls: executed,
          rounds,
        };
      }
      if (browserTask && executed.length === 0) {
        if (!browserRetryUsed) {
          browserRetryUsed = true;
          // Retry SEKALI dengan instruksi eksplisit WAJIB panggil
          // tool — loop lanjut ke ronde berikutnya, bukan return.
          messages = [
            ...messages,
            {
              role: 'user',
              content:
                'WAJIB: tugas ini adalah tugas browser. Kamu HARUS memanggil tool open_browser ke URL target, lalu browser_list_elements untuk melihat halaman itu, sebelum menjawab. Jangan menjawab dari ingatan atau menebak daftar elemen, judul, atau jumlah. Bila tool gagal, katakan dengan jujur bahwa tool tidak jalan — jangan mengarang.',
            },
          ];
          continue;
        }
        // Retry sudah dipakai tapi model tetap tidak memanggil tool:
        // JANGAN posting teks model (berisiko karangan). Laporkan
        // jujur bahwa tool tidak jalan.
        return {
          streamed: lastStreamed,
          text: 'Tool tidak jalan: saya tidak bisa membuka browser dan memverifikasi halaman lewat tool di turn ini, jadi saya tidak mengarang daftar elemen, judul, atau jumlahnya. Coba kirim lagi.',
          usage: lastUsage,
          model: lastModel,
          toolCalls: executed,
          rounds,
        };
      }
      return {
        streamed: lastStreamed,
        text: applyResearchLabel(text),
        usage: lastUsage,
        model: lastModel,
        toolCalls: executed,
        rounds,
      };
    }

    // Model meminta tool: eksekusi satu per satu, lalu kirim hasilnya.
    const assistantMsg: ChatMessage = { role: 'assistant', content: text, tool_calls: toolCalls };
    messages = [...messages, assistantMsg];
    let roundAllFailed = toolCalls.length > 0;
    let roundAllRepeats = toolCalls.length > 0;
    // Progres nyata ronde ini: ada call BARU (bukan cache) yang sukses.
    let roundProgress = false;
    for (const rawCall of toolCalls) {
      const parsed = parseToolCallArgs(rawCall);
      opts.onToolCall?.(parsed, rounds);
      const signature = `${parsed.name}\n${parsed.argsRaw}`;
      let result: string;
      let fromCache = false;
      if (seenResults.has(signature)) {
        // 0.10.7 dedupe: call identik — kembalikan hasil lama, jangan
        // eksekusi ulang (tidak ada POST sandbox kedua, tidak ada efek
        // samping ganda).
        result = seenResults.get(signature) as string;
        fromCache = true;
      } else {
        try {
          result = await opts.execTool(parsed);
        } catch (e) {
          result = `Tool ${parsed.name} gagal: ${
            e instanceof Error ? e.message : 'error tak dikenal'
          }. Beri tahu pengguna dengan jujur.`;
        }
        seenResults.set(signature, result);
      }
      if (!fromCache) roundAllRepeats = false;
      if (isToolFailureResult(result)) {
        failedBySignature.set(signature, (failedBySignature.get(signature) ?? 0) + 1);
      } else {
        roundAllFailed = false;
        // Hasil BARU yang sukses = progres (bukan pengulangan/gagal).
        if (!fromCache) roundProgress = true;
      }
      executed.push(parsed);
      messages = [
        ...messages,
        { role: 'tool', tool_call_id: rawCall.id, content: result },
      ];
      // 0.10.7: satu tool gagal 2x (signature sama) — berhenti, paksa
      // jawaban akhir dari yang diketahui, jangan retry buta.
      if ((failedBySignature.get(signature) ?? 0) >= 2) {
        return buildResult(
          (await finishWithSummary()) ||
            'Tool gagal berulang kali; hasilnya tidak bisa dirangkum. Coba lagi dengan perintah yang lebih sederhana.',
        );
      }
    }
    if (roundAllFailed) {
      consecutiveFailedRounds += 1;
    } else {
      consecutiveFailedRounds = 0;
    }
    if (roundAllRepeats) {
      consecutiveRepeatRounds += 1;
    } else {
      consecutiveRepeatRounds = 0;
    }
    // 0.10.7 stall: ronde tanpa hasil tool BARU yang sukses.
    if (roundProgress) {
      noProgressRounds = 0;
    } else {
      noProgressRounds += 1;
    }
    // 0.10.7: 2 ronde berturut-turut semua gagal, atau 2 ronde
    // berturut-turut hanya mengulang call lama — model terjebak.
    // Berhenti dan paksa jawaban akhir.
    if (consecutiveFailedRounds >= 2 || consecutiveRepeatRounds >= 2) {
      return buildResult(
        (await finishWithSummary()) ||
          'Perintah sudah dijalankan tetapi hasilnya tidak bisa dirangkum. Tanyakan lagi bila perlu hasilnya dirangkum.',
      );
    }
    // 0.10.7 stall (FULL CAP): 3 ronde berturut-turut tanpa
    // progres (campuran ulang + gagal) — model tidak berprogres,
    // berhenti dan rangkum, jangan biarkan loop jalan sampai 100.
    if (noProgressRounds >= TOOL_LOOP_STALL_ROUNDS) {
      return buildResult(
        (await finishWithSummary()) ||
          'Perintah sudah dijalankan tetapi hasilnya tidak bisa dirangkum. Tanyakan lagi bila perlu hasilnya dirangkum.',
      );
    }
  }

  // Loop berakhir (hard ceiling 100 atau maxRounds eksplisit)
  // sementara model masih meminta tool — beri model satu
  // kesempatan terakhir menjawab tanpa tool (0.10.7), lalu
  // rangkuman parsial dari hasil tool, supaya chat tidak
  // menggantung di pesan batas putaran.
  return buildResult(
    (await finishWithSummary()) ||
      'Perintah sudah dijalankan tetapi hasilnya tidak bisa dirangkum. Tanyakan lagi bila perlu hasilnya dirangkum.',
  );
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Cap-gated BYO send: checks the daily cap FIRST (GET
 * /api/costs/cap-check) and never calls the model when the gate
 * refuses — the model call (and its spend) must not happen for a
 * capped bot. Throws CapBlockedError when allowed === false.
 * `checkCapFn` is injectable for tests; production passes the real
 * client checkCap.
 */
export async function sendByoChat(
  cfg: ByoConfig,
  botId: string,
  content: ChatContent,
  onDelta?: (fullText: string) => void,
  abortSignal?: AbortSignal,
  checkCapFn: (bot: string) => Promise<CapCheck> = checkCap,
  systemPrompt?: string | null,
  history?: ChatMessage[] | null,
): Promise<ByoReply> {
  const gate = await checkCapFn(botId);
  if (!gate.allowed) throw new CapBlockedError(gate);
  return streamByoReply(cfg, content, onDelta, abortSignal, systemPrompt, history);
}
