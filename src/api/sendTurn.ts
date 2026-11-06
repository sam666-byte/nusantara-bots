/**
 * sendTurn.ts — eksekusi satu turn chat, BEBAS FRAMEWORK.
 *
 * Langkah 2 Nusantara (turn tahan background): alur yang tadinya hidup
 * di ChatScreen.send() dipindah ke sini apa adanya — router delegasi
 * eksplisit, putaran perbaikan (create_bot, eksekusi tugas, delegasi),
 * persist, cost — supaya DUA host bisa memakainya:
 *   (a) aplikasi (host app: setter React + SecureStore HP + mock path),
 *   (b) runner Node di server (host runner: tanpa UI, persist no-op
 *       karena server sudah menyimpan pesan user saat submit dan
 *       memposting balasan saat complete, kredensial {saved:false}).
 *
 * Yang membuat pendekatan ini aman: guard riset (byo.ts: retry WAJIB +
 * carve-out hasDelegated + label "ide mentah" + gagal-jujur) dan guard
 * browser fix22 tinggal di byo.ts dan dipakai ulang utuh lewat
 * streamByoReplyWithTools — tidak ada port ulang, tidak ada perilaku
 * yang harus dibuktikan ulang. Modul ini hanya memindah perakitan
 * (assembly) keluar dari komponen React.
 *
 * Host menyediakan SEMUA yang berbau UI/state. Modul ini tidak
 * mengimpor react, react-native, expo, atau navigation — jadi bisa
 * dikompilasi Node apa adanya (dengan shim storage + xhr2).
 */

import {
  checkCapOrAllow,
  createDelegations,
  recordCost,
  recordUnmeasuredCost,
} from './client';
import { setComputerLeaseId } from './teamComputer';
import {
  getByo,
  streamByoReplyWithTools,
  wasByoEverConfigured,
  type ChatTool,
  type ParsedToolCall,
} from './byo';
import {
  buildTaskExecutionRepairPrompt,
  looksLikePlanOnly,
  wantsTaskExecution,
} from './taskExecution';
import {
  completeTurn,
  isTurnRunning,
  pruneStaleTurn,
  registerTurn,
  updateTurn,
} from './turnRunner';
import {
  VM_EXEC_TOOL,
  VM_EXEC_TOOL_NAME,
  checkSandboxAvailable,
  executeVmExecTool,
} from './sandbox';
import {
  CREATE_BOT_TOOL,
  CREATE_BOT_TOOL_NAME,
  LIST_BOTS_TOOL,
  LIST_BOTS_TOOL_NAME,
  executeBotTool,
} from './botTools';
import {
  CHECK_DELEGATION_STATUS_TOOL_NAME,
  DELEGATION_TOOLS,
  HANDOFF_TO_BOT_TOOL_NAME,
  MESSAGE_BOT_TOOL_NAME,
  executeDelegationStatusTool,
  executeDelegationTool,
} from './delegationTools';
import {
  CREATE_ROOM_TOOL,
  CREATE_ROOM_TOOL_NAME,
  executeCreateRoomTool,
} from './roomTools';
import {
  LIST_FILES_TOOL,
  LIST_FILES_TOOL_NAME,
  READ_FILE_TOOL,
  READ_FILE_TOOL_NAME,
  executeFileTool,
} from './fileTools';
import {
  GET_TEAM_MEMORY_TOOL,
  GET_TEAM_MEMORY_TOOL_NAME,
  GET_TEAM_STATUS_TOOL,
  GET_TEAM_STATUS_TOOL_NAME,
  SAVE_TEAM_MEMORY_TOOL,
  SAVE_TEAM_MEMORY_TOOL_NAME,
  executeTeamTool,
} from './teamTools';
import {
  ASSIGN_SKILL_TOOL,
  ASSIGN_SKILL_TOOL_NAME,
  CREATE_SKILL_TOOL,
  CREATE_SKILL_TOOL_NAME,
  LIST_SKILLS_TOOL,
  LIST_SKILLS_TOOL_NAME,
  executeSkillTool,
} from './skillTools';
import { executeMcpTool, getMcpTools } from './mcpTools';
import {
  BROWSER_CLICK_TOOL,
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_LIST_ELEMENTS_TOOL,
  BROWSER_LIST_ELEMENTS_TOOL_NAME,
  BROWSER_SCROLL_TOOL,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_TYPE_TOOL,
  BROWSER_TYPE_TOOL_NAME,
  BROWSER_ZOOM_TOOL,
  BROWSER_ZOOM_TOOL_NAME,
  OPEN_BROWSER_TOOL,
  OPEN_BROWSER_TOOL_NAME,
  WEB_OPEN_TOOL,
  WEB_OPEN_TOOL_NAME,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_NAME,
  executeBrowserClickTool,
  executeBrowserListElementsTool,
  executeBrowserScrollTool,
  executeBrowserTypeTool,
  executeBrowserZoomTool,
  executeOpenBrowserTool,
  executeWebOpenTool,
  executeWebSearchTool,
} from './browserTools';
import {
  CREDENTIAL_TOOLS,
  LIST_SECRETS_TOOL_NAME,
  LOGIN_SERVICE_TOOL_NAME,
  REQUEST_CREDENTIAL_TOOL_NAME,
  executeCredentialTool,
} from './credentialTools';
import { buildSystemPrompt } from './systemPrompt';
import type { ThinkingState } from './thinking';
import type { CredentialFormResult } from './credentialTools';
import type {
  Character,
  ChatMessage,
  MockChatResponse,
  PersistMessageResponse,
  TokenUsage,
} from './types';

/** Pesan UI: pesan server + flag lokal (sama seperti UiMessage di ChatScreen). */
export type TurnUiMessage = ChatMessage & { local?: boolean; streaming?: boolean };

export type TurnStatus = 'done' | 'error' | 'stopped';

export interface TurnResult {
  status: TurnStatus;
  /** Teks akhir turn (untuk runner: diposting server saat complete). */
  finalText: string | null;
  usage: TokenUsage | null;
}

/**
 * Semua yang berbau host. App mengisi dengan setter React + ref;
 * runner mengisi dengan no-op / array lokal / resolver {saved:false}.
 */
export interface TurnHost {
  roomId: string;
  characterId: string | null;
  roomMembers: string[];
  character: Character | null | undefined;
  displayName: string;
  characters: Character[];
  allowAllTools: (call: ParsedToolCall) => Promise<boolean>;
  /** Snapshot riwayat SEBELUM pesan turn ini (turn saat ini tidak duplikat). */
  priorMessages: ChatMessage[];
  replyTarget: { id: number; text: string } | null;
  /** Runner: false — tanpa BYO, gagal jujur, jangan pernah mock. */
  allowMock: boolean;
  clearInput(): void;
  clearReplyTarget(): void;
  setCapBlocked(blocked: boolean): void;
  setReplying(replying: boolean): void;
  setThinking(state: ThinkingState | null): void;
  setServerWarning(msg: string | null): void;
  updateMessages(fn: (prev: TurnUiMessage[]) => TurnUiMessage[]): void;
  /** Teks streaming terakhir untuk bubble ini (jalur parsial di catch). */
  getStreamText(streamId: number): string;
  startThinking(): void;
  noteThinkingProgress(): void;
  showThinkingTool(call: ParsedToolCall, round?: number): void;
  runTypewriter(fullText: string, streamId: number, serverAssistantId: number): void;
  requestCredential(input: {
    service: string;
    label: string;
    url: string;
  }): Promise<CredentialFormResult>;
  /** App: persist sungguhan. Runner: no-op (return null) — server yang posting. */
  persistMessage(
    room: string,
    character: string | null,
    text: string,
    role: 'user' | 'assistant',
    replyTo?: string,
  ): Promise<PersistMessageResponse | null>;
  persistMessageWithRetry(
    room: string,
    character: string | null,
    text: string,
    role: 'user' | 'assistant',
    replyTo?: string,
  ): Promise<PersistMessageResponse | null>;
  /** App: sendMockChat. Runner: tidak pernah dipanggil (allowMock false). */
  sendMock(
    room: string,
    character: string,
    text: string,
  ): Promise<MockChatResponse | null>;
  isBusy(): boolean;
  setAbortController(controller: AbortController | null): void;
}

// --- ID lokal + waktu (pindahan dari ChatScreen, satu counter bersama) ---

let localId = -1;

export function nextLocalId(): number {
  localId -= 1;
  return localId;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newTaskId(): string {
  return `chat-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Deteksi niat membuat bot (0.10.13, perbaikan create_bot).
 * Pindahan verbatim dari ChatScreen.
 */
export function wantsCreateBot(text: string): boolean {
  const t = text.toLowerCase();
  const hasVerb = /\b(buat|buatkan|bikin|bentuk|tambah|tambahkan|create|make)\b/.test(t);
  const hasBot = /\b(bot|tim)\b/.test(t);
  return hasVerb && hasBot;
}

/**
 * Parse perintah delegasi EKSPLISIT dari pengguna (31 Okt 2026, gaya delegasi).
 * Pindahan verbatim dari ChatScreen.
 */
export function parseExplicitDelegation(text: string): { target: string; task: string } | null {
  const t = text.trim();
  const prefix = String.raw`(?:[^,\n]{1,20},\s*|[^\n.!?]{1,40}?\s+)?`;
  const verb = String.raw`(?:delegasikan|suruh|perintahkan|minta(?:kan)?|tugaskan)`;
  const guard = /^(?:[^\n]*?)(sudah|telah|kemarin|tadi|jangan|tidak|bukan)\b/i;
  const patterns = [
    new RegExp(`^${prefix}${verb}\\s+(?:ke\\s+)?([A-Za-z0-9_-]+)\\s*[:\uFF1A]\\s*(.+)$`, 'is'),
    new RegExp(`^${prefix}${verb}\\s+(?:ke\\s+)?([A-Za-z0-9_-]+)\\s+untuk\\s+(.+)$`, 'is'),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[2].trim().length >= 3) {
      const verbIdx = t.search(new RegExp(verb, 'i'));
      if (verbIdx > 0 && guard.test(t.slice(0, verbIdx))) continue;
      return { target: m[1].trim(), task: m[2].trim() };
    }
  }
  return null;
}

/** Klaim delegasi di teks balasan model (tanpa tool call = karangan). */
export function claimsDelegation(text: string): boolean {
  return /(sudah|telah)\s+mendelegasikan|saya\s+delegasikan\s+ke|aku\s+delegasikan\s+ke|bot\s+(akan|sedang)\s+mengerjakan/i.test(
    text,
  );
}

/**
 * Parser delegasi multi-target (Fase 8). Pindahan verbatim dari ChatScreen.
 */
export function parseExplicitDelegations(
  text: string,
): { targets: string[]; task: string } | null {
  const t = text.trim();
  const verbRe = /(delegasikan|suruh|perintahkan|minta(?:kan)?|tugaskan)/i;
  const vm = t.match(verbRe);
  if (!vm || vm.index === undefined) return null;
  const before = t.slice(0, vm.index);
  if (before.length > 60) return null;
  if (/\b(sudah|telah|kemarin|tadi|jangan|tidak|bukan)\b/i.test(before)) return null;
  let rest = t.slice(vm.index + vm[0].length).trim();
  rest = rest.replace(/^ke\s+/i, '');
  let splitIdx = -1;
  let splitLen = 0;
  const colon = rest.indexOf(':');
  const untuk = rest.search(/\s+untuk\s+/i);
  if (colon >= 0 && (untuk < 0 || colon < untuk)) {
    splitIdx = colon;
    splitLen = 1;
  } else if (untuk >= 0) {
    splitIdx = untuk;
    splitLen = rest.slice(untuk).match(/^\s+untuk\s+/)![0].length;
  } else {
    return null;
  }
  const targetsPart = rest.slice(0, splitIdx).trim();
  const task = rest.slice(splitIdx + splitLen).trim();
  if (task.length < 3 || !targetsPart) return null;
  const segments = targetsPart.split(/\s*,\s*|\s+dan\s+|\s*&\s*|\s*\+\s*/i);
  const targets: string[] = [];
  for (const seg of segments) {
    const s = seg.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    if (!targets.includes(s)) targets.push(s);
  }
  if (targets.length === 0) return null;
  return { targets, task };
}

/**
 * Jalankan satu turn penuh. Pindahan verbatim alur ChatScreen.send()
 * (0.10.5–0.10.15) — hanya setState/ref diganti host, dan hasil akhir
 * dikembalikan (bukan void) supaya runner bisa mempostingnya.
 */
export async function runSendTurn(host: TurnHost, rawText: string, opts?: { computerLeaseId?: string }): Promise<TurnResult> {
  const { roomId } = host;
  const text = rawText.trim();
  if (!text || host.isBusy()) return { status: 'stopped', finalText: null, usage: null };
  // 0.10.14: jangan mulai turn baru bila turn room ini masih jalan.
  // fix21: bersihkan turn menggantung supaya kirim berikutnya tidak macet.
  pruneStaleTurn(roomId);
  if (isTurnRunning(roomId)) {
    console.warn('[sendTurn] diblokir: turn room ini masih berjalan', roomId);
    return { status: 'stopped', finalText: null, usage: null };
  }
  host.clearInput();
  host.setCapBlocked(false);
  // Snapshot riwayat SEBELUM userMsg/streamMsg di-append (0.10.5).
  // Reply (0.10.6): snapshot target balasannya, lalu bersihkan bar konteks.
  const reply = host.replyTarget;
  if (reply) host.clearReplyTarget();
  const basePrompt = reply
    ? `(Membalas "${reply.text.slice(0, 200)}") ${text}`
    : text;
  const priorMessages = host.priorMessages;

  // 1. Cek batas pemakaian dulu (fail-open bila ledger tak terjangkau).
  const who = host.characterId ?? host.roomMembers[0] ?? roomId;
  let resultText: string | null = null;
  try {
    const cap = await checkCapOrAllow(host.characterId ?? roomId);
    if (!cap.allowed) {
      host.setCapBlocked(true);
      const capText = cap.message || 'Batas pemakaian bot ini sudah tercapai. Coba lagi nanti.';
      host.updateMessages((prev) => [
        ...prev,
        {
          id: nextLocalId(),
          room: roomId,
          character: host.characterId ?? null,
          role: 'assistant',
          text: capText,
          created_at: nowIso(),
          local: true,
        },
      ]);
      resultText = capText;
      return { status: 'done', finalText: resultText, usage: null };
    }
  } catch {
    // checkCapOrAllow sudah fail-open; ini hanya pengaman.
  }

  const userMsg: TurnUiMessage = {
    id: nextLocalId(),
    room: roomId,
    character: host.characterId ?? null,
    role: 'user',
    text,
    created_at: nowIso(),
    local: true,
  };
  const streamId = nextLocalId();
  const streamMsg: TurnUiMessage = {
    id: streamId,
    room: roomId,
    character: host.characterId ?? null,
    role: 'assistant',
    text: '',
    created_at: nowIso(),
    local: true,
    streaming: true,
  };
  host.updateMessages((prev) => [...prev, userMsg, streamMsg]);
  host.setReplying(true);
  host.startThinking();
  const controller = new AbortController();
  host.setAbortController(controller);
  // 0.10.14: daftarkan turn ke turnRunner (generasi: turn lama yang
  // akhirnya selesai tidak menimpa turn baru di room yang sama).
  const turn = registerTurn(roomId, controller);
  // Fase 4(a): ikat aksi komputer turn ini ke satu lease id.
  // Runner mengoper srv:<id>; app tanpa opts mendapat id
  // segar per invokasi (satu invokasi = satu turn logis).
  const leaseId = opts?.computerLeaseId ?? `app:${roomId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const prevLeaseId = setComputerLeaseId(leaseId);
  let turnStatus: TurnStatus = 'done';
  let usage: TokenUsage | null = null;

  try {
    // 0.10.13: BYO FLAKY — SecureStore kadang gagal baca sesaat.
    // Retry sekali sebelum menyerah; bila BYO pernah dikonfigurasi
    // tapi kini tidak terbaca, tampilkan error JELAS (bukan MOCK).
    let byo = await getByo().catch(() => null);
    if (!byo) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      byo = await getByo().catch(() => null);
    }
    if (!byo && (await wasByoEverConfigured().catch(() => false))) {
      const errText =
        '⚠️ BYO tidak terbaca — konfigurasi model yang sebelumnya tersimpan kini tidak bisa dibaca dari HP ini. Pesanmu tersimpan, tapi aku tidak bisa menjawab dengan model. Coba tutup lalu buka lagi aplikasi; bila masih begini, isi ulang BYO (Settings → Model API sendiri) atau minta Muse mengecek.';
      try {
        const savedUser = await host.persistMessage(roomId, host.characterId ?? null, text, 'user');
        if (savedUser) {
          host.updateMessages((prev) =>
            prev.map((m) => (m.id === userMsg.id ? { ...m, id: savedUser.message.id, local: false } : m)),
          );
        }
      } catch {
        host.setServerWarning(
          'Server tidak terjangkau — pesan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
        );
      }
      host.updateMessages((prev) =>
        prev.map((m) => (m.id === streamId ? { ...m, text: errText, streaming: false } : m)),
      );
      try {
        const savedErr = await host.persistMessageWithRetry(roomId, host.characterId ?? null, errText, 'assistant');
        if (savedErr) {
          host.updateMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, id: savedErr.message.id, local: false } : m)),
          );
        }
      } catch {
        // Balasan error gagal tersimpan — tetap tampil di layar.
      }
      host.setServerWarning(
        'BYO tidak terbaca — model asli tidak bisa dipakai. Coba tutup-buka aplikasi, atau import ulang BYO.',
      );
      resultText = errText;
      return { status: 'done', finalText: resultText, usage: null };
    }
    if (byo) {
      // 2a. BYO tersedia: pesan user dikirim apa adanya ke model.
      const modelPrompt = basePrompt;
      // System prompt berlapis (0.9.9): persona + SOUL + hierarki +
      // gaya + skills + kemampuan. Sandbox dicek sekali per kirim
      // (fail-soft) dan daftar tool MCP diambil paralel.
      const [sandbox, mcpTools] = await Promise.all([
        checkSandboxAvailable().catch(() => ({ available: false, workspace: null })),
        getMcpTools(),
      ]);
      const sandboxAvailable = sandbox.available;
      const sandboxWorkspace = sandbox.workspace;
      const systemPrompt = buildSystemPrompt(host.character, host.displayName, {
        sandboxAvailable,
        workspace: sandboxWorkspace,
        botToolsAvailable: true,
        skillToolsAvailable: true,
        mcpToolsAvailable: mcpTools.length > 0,
        mcpToolNames: mcpTools.map((t) => t.function.name),
      });
      const onDelta = (full: string) => {
        host.setThinking(null);
        host.noteThinkingProgress();
        host.updateMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, text: full } : m)));
        // 0.10.14: publikasikan teks streaming ke turnRunner.
        updateTurn(roomId, { text: full, thinking: '' }, turn.generation);
      };
      const onToolCall = (call: ParsedToolCall, round?: number) => {
        host.showThinkingTool(call, round);
        updateTurn(roomId, { thinking: call.name }, turn.generation);
      };
      // Tool chat (0.10.0): tool bot SELALU tersedia; tool kredensial
      // SELALU tersedia; open_browser SELALU tersedia; vm_exec hanya
      // bila sandbox tersedia; tool MCP bila server menyediakannya.
      // Tool tulis MCP SELALU diizinkan (ALWAYS ALLOW 0.10.7);
      // request_credential dijeda untuk form aman.
      const tools: ChatTool[] = [
        CREATE_BOT_TOOL,
        LIST_BOTS_TOOL,
        ...DELEGATION_TOOLS,
        CREATE_ROOM_TOOL,
        LIST_FILES_TOOL,
        READ_FILE_TOOL,
        GET_TEAM_MEMORY_TOOL,
        GET_TEAM_STATUS_TOOL,
        SAVE_TEAM_MEMORY_TOOL,
        CREATE_SKILL_TOOL,
        LIST_SKILLS_TOOL,
        ASSIGN_SKILL_TOOL,
        ...CREDENTIAL_TOOLS,
        OPEN_BROWSER_TOOL,
        BROWSER_CLICK_TOOL,
        BROWSER_LIST_ELEMENTS_TOOL,
        BROWSER_TYPE_TOOL,
        BROWSER_SCROLL_TOOL,
        BROWSER_ZOOM_TOOL,
        WEB_SEARCH_TOOL,
        WEB_OPEN_TOOL,
      ];
      if (sandboxAvailable) tools.push(VM_EXEC_TOOL);
      tools.push(...mcpTools);
      const execTool = async (call: ParsedToolCall): Promise<string> => {
        if (call.name === VM_EXEC_TOOL_NAME) return executeVmExecTool(call);
        if (call.name === CREATE_BOT_TOOL_NAME || call.name === LIST_BOTS_TOOL_NAME) {
          return executeBotTool(call, host.characterId ?? host.roomMembers[0] ?? undefined);
        }
        if (call.name === MESSAGE_BOT_TOOL_NAME || call.name === HANDOFF_TO_BOT_TOOL_NAME) {
          // Video-parity Tahap 2: delegasi Chief -> spesialis.
          return executeDelegationTool(call, {
            chiefId: host.characterId ?? host.roomMembers[0] ?? null,
            chiefRoomId: roomId,
          });
        }
        if (call.name === CHECK_DELEGATION_STATUS_TOOL_NAME) {
          // Fase 9: cek status delegasi dari server — jangan menebak.
          return executeDelegationStatusTool(call);
        }
        if (call.name === CREATE_ROOM_TOOL_NAME) {
          // Ruang rapat: model boleh membuat ruangan (server POST /api/rooms).
          return executeCreateRoomTool(call, {
            callerId: host.characterId ?? host.roomMembers[0] ?? null,
          });
        }
        if (
          call.name === LIST_FILES_TOOL_NAME ||
          call.name === READ_FILE_TOOL_NAME
        ) {
          // File tools (opsi 2, 1 Nov 2026).
          return executeFileTool(call);
        }
        if (
          call.name === GET_TEAM_MEMORY_TOOL_NAME ||
          call.name === GET_TEAM_STATUS_TOOL_NAME ||
          call.name === SAVE_TEAM_MEMORY_TOOL_NAME
        ) {
          // Team tools (1 Nov 2026).
          return executeTeamTool(call);
        }
        if (
          call.name === CREATE_SKILL_TOOL_NAME ||
          call.name === LIST_SKILLS_TOOL_NAME ||
          call.name === ASSIGN_SKILL_TOOL_NAME
        ) {
          return executeSkillTool(call);
        }
        if (call.name === OPEN_BROWSER_TOOL_NAME) return executeOpenBrowserTool(call);
        if (call.name === BROWSER_CLICK_TOOL_NAME) return executeBrowserClickTool(call);
        if (call.name === BROWSER_LIST_ELEMENTS_TOOL_NAME) return executeBrowserListElementsTool(call);
        if (call.name === BROWSER_TYPE_TOOL_NAME) return executeBrowserTypeTool(call);
        if (call.name === BROWSER_SCROLL_TOOL_NAME) return executeBrowserScrollTool(call);
        if (call.name === BROWSER_ZOOM_TOOL_NAME) return executeBrowserZoomTool(call);
        if (call.name === WEB_SEARCH_TOOL_NAME) return executeWebSearchTool(call);
        if (call.name === WEB_OPEN_TOOL_NAME) return executeWebOpenTool(call);
        if (
          call.name === LIST_SECRETS_TOOL_NAME ||
          call.name === REQUEST_CREDENTIAL_TOOL_NAME ||
          call.name === LOGIN_SERVICE_TOOL_NAME
        ) {
          // 0.10.14: lewat host — app: form bila fokus, {saved:false}
          // bila background; runner: selalu {saved:false}.
          return executeCredentialTool(call, host.requestCredential);
        }
        return executeMcpTool(call, host.allowAllTools);
      };
      // Batas waktu eksekusi tool (0.10.5): satu tool yang menggantung
      // tidak boleh membekukan chat — setelah 180 dtk, kembalikan
      // teks timeout supaya model menjawab dari yang sudah diketahui.
      const TOOL_CALL_TIMEOUT_MS = 180_000;
      const execToolWithTimeout = async (call: ParsedToolCall): Promise<string> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          return await Promise.race([
            execTool(call),
            new Promise<string>((resolve) => {
              timer = setTimeout(
                () =>
                  resolve(
                    `Tool ${call.name} timeout setelah 180 detik — hasilnya tidak tersedia. ` +
                      'Jawab dari yang sudah diketahui, jangan mengulang tool yang sama.',
                  ),
                TOOL_CALL_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      // Simpan pesan user SEBELUM memanggil model (0.10.5).
      // Offline-first: gagal simpan tidak menggagalkan chat — tapi
      // mulai 0.10.12 kegagalan DITAMPILKAN sebagai banner.
      try {
        const savedUser = await host.persistMessage(
          roomId,
          host.characterId ?? null,
          text,
          'user',
          reply ? String(reply.id) : undefined,
        );
        if (savedUser) {
          host.updateMessages((prev) =>
            prev.map((m) => (m.id === userMsg.id ? { ...m, id: savedUser.message.id, local: false } : m)),
          );
          host.setServerWarning(null);
        }
      } catch {
        host.setServerWarning(
          'Server tidak terjangkau — pesan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
        );
      }
      // Router delegasi eksplisit gaya delegasi (31 Okt 2026): bila
      // pengguna MEMERINTAHKAN delegasi ke bot bernama, langsung
      // memanggil message_bot — tidak menunggu model.
      const isChiefRoom =
        (host.character?.role ?? '').toLowerCase().includes('chief') ||
        roomId === 'x' ||
        host.characterId === 'x';
      // Gerbang router diperkuat (31 Okt 2026): perintah eksplisit
      // juga di-router bila bot targetnya ADA di daftar bot server.
      const parsedMulti = parseExplicitDelegations(text);
      const parsedSingle = parsedMulti ? null : parseExplicitDelegation(text);
      const parsedDelegation = parsedMulti
        ? { targets: parsedMulti.targets, task: parsedMulti.task }
        : parsedSingle
          ? { targets: [parsedSingle.target], task: parsedSingle.task }
          : null;
      const targetsExist = parsedDelegation
        ? parsedDelegation.targets.every((tg) =>
            host.characters.some((c) => c.id.toLowerCase() === tg.toLowerCase()),
          )
        : false;
      const explicitDelegation =
        isChiefRoom || targetsExist ? parsedDelegation : null;
      if (explicitDelegation && !controller.signal.aborted) {
        // Satu panggilan server (Fase 8): validasi atomik untuk
        // semua target, satu record per target.
        let hash = 0;
        const keySrc = `${host.characterId ?? 'user'}:${explicitDelegation.targets.join(',')}:${explicitDelegation.task}`;
        for (let i = 0; i < keySrc.length; i += 1) {
          hash = (hash * 31 + keySrc.charCodeAt(i)) | 0;
        }
        const deliveryKey = `dlg:${host.characterId ?? 'user'}:${Math.abs(hash)}`;
        let delegationResult: string;
        try {
          const created = await createDelegations({
            targets: explicitDelegation.targets,
            message: explicitDelegation.task,
            chief_id: host.characterId ?? null,
            chief_room_id: roomId,
            delivery_key: deliveryKey,
          });
          if (!created) {
            delegationResult = 'Delegasi tidak dikirim: server tidak menjawab. Jangan mengklaim delegasi sudah terkirim.';
          } else if (!created.ok) {
            delegationResult = `Delegasi tidak dikirim: ${created.error}. Jangan mengklaim delegasi sudah terkirim.`;
          } else {
            delegationResult = created.delegations
              .map(
                (rec, i) =>
                  `Didelegasikan ke "${rec.target_name}" (delegasi #${rec.id}, room ${rec.target_room})${created.replayed[i] ? ' (pengiriman ulang — record yang sama, tidak ganda)' : ''}`,
              )
              .join(' ') + ' Runner akan mengeksekusinya dan hasilnya kembali ke room ini.';
          }
        } catch (e) {
          delegationResult = `Delegasi tidak dikirim: server menolak (${e instanceof Error ? e.message : 'error tak dikenal'}). Jangan mengklaim delegasi sudah terkirim.`;
        }
        host.setThinking(null);
        host.updateMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, text: delegationResult, streaming: false } : m)),
        );
        if (!controller.signal.aborted) {
          try {
            const savedAsst = await host.persistMessageWithRetry(roomId, host.characterId ?? null, delegationResult, 'assistant');
            if (savedAsst) {
              host.updateMessages((prev) =>
                prev.map((m) => (m.id === streamId ? { ...m, id: savedAsst.message.id, local: false } : m)),
              );
              host.setServerWarning(null);
            }
          } catch {
            host.setServerWarning(
              'Server tidak terjangkau — balasan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
            );
          }
        }
        resultText = delegationResult;
        return { status: 'done', finalText: resultText, usage: null };
      }
      let res = await streamByoReplyWithTools(byo, modelPrompt, {
        tools,
        execTool: execToolWithTimeout,
        systemPrompt,
        // Riwayat chat (0.10.5, perbaikan "pikun"): turn-turn
        // sebelumnya supaya model ingat konteks. Batas 20 pesan
        // terakhir ditegakkan di byo.ts (takeRecentHistory).
        history: priorMessages
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              m.text.trim().length > 0,
          )
          .map((m) => ({ role: m.role, content: m.text })),
        onDelta,
        onToolCall,
        abortSignal: controller.signal,
      });
      // 0.10.13: PUTARAN PERBAIKAN create_bot — bila pengguna
      // meminta membuat bot tapi model TIDAK memanggil create_bot
      // sama sekali (malah mengarang klaim sukses), jalankan SATU
      // putaran lagi yang memaksa model memanggil create_bot.
      const didCreateBot = (res.toolCalls ?? []).some(
        (c) => c.name === CREATE_BOT_TOOL_NAME,
      );
      if (wantsCreateBot(text) && !didCreateBot && !controller.signal.aborted) {
        try {
          const repair = await streamByoReplyWithTools(
            byo,
            `PERINTAH PERBAIKAN — kamu diminta membuat bot ("${text.slice(0, 200)}") tapi kamu BELUM memanggil tool create_bot sama sekali. JANGAN percaya riwayat chat yang mengklaim bot sudah dibuat — riwayat itu bisa berisi karanganmu sendiri. Cek dulu dengan list_bots, lalu panggil create_bot SEKARANG untuk setiap bot yang diminta dan belum ada (satu panggilan per bot, jangan menulis rencana dulu). Setelah tool mengembalikan hasil, laporkan nama + id bot yang dibuat.`,
            {
              tools,
              execTool: execToolWithTimeout,
              systemPrompt,
              history: priorMessages
                .filter(
                  (m) =>
                    (m.role === 'user' || m.role === 'assistant') &&
                    m.text.trim().length > 0,
                )
                .map((m) => ({ role: m.role, content: m.text }))
                .concat([{ role: 'user', content: text }]),
              onDelta,
              onToolCall,
              abortSignal: controller.signal,
            },
          );
          res = repair;
        } catch {
          // Perbaikan gagal — pakai hasil putaran pertama apa adanya.
        }
      }
      // 0.10.14: PUTARAN PERBAIKAN eksekusi tugas — bila pengguna
      // meminta MENGERJAKAN sesuatu tapi model TIDAK memanggil tool
      // sama sekali dan balasannya tampak seperti rencana, jalankan
      // SATU putaran lagi yang memaksa model memanggil tool.
      const didAnyTool = (res.toolCalls ?? []).length > 0;
      if (
        wantsTaskExecution(text) &&
        !didAnyTool &&
        looksLikePlanOnly(res.text) &&
        !controller.signal.aborted
      ) {
        try {
          const repair = await streamByoReplyWithTools(
            byo,
            buildTaskExecutionRepairPrompt(text),
            {
              tools,
              execTool: execToolWithTimeout,
              systemPrompt,
              history: priorMessages
                .filter(
                  (m) =>
                    (m.role === 'user' || m.role === 'assistant') &&
                    m.text.trim().length > 0,
                )
                .map((m) => ({ role: m.role, content: m.text }))
                .concat([{ role: 'user', content: text }]),
              onDelta,
              onToolCall,
              abortSignal: controller.signal,
            },
          );
          res = repair;
        } catch {
          // Perbaikan gagal — pakai hasil putaran pertama apa adanya.
        }
      }
      // 0.10.15: PUTARAN PERBAIKAN delegasi (pola delegasi Fase 7) —
      // bila pengguna memerintah delegasi eksplisit ATAU balasan
      // model mengklaim sudah mendelegasikan, tapi TIDAK ADA
      // panggilan message_bot/handoff_to_bot di giliran ini,
      // jalankan SATU putaran lagi yang memaksa model memanggil
      // tool delegasi.
      let didDelegate = (res.toolCalls ?? []).some(
        (c) =>
          c.name === MESSAGE_BOT_TOOL_NAME ||
          c.name === HANDOFF_TO_BOT_TOOL_NAME,
      );
      for (let repairRound = 0; repairRound < 2; repairRound += 1) {
        if (
          didDelegate ||
          controller.signal.aborted ||
          !(
            parseExplicitDelegation(text) !== null ||
            parseExplicitDelegations(text) !== null ||
            claimsDelegation(res.text)
          )
        ) {
          break;
        }
        try {
          const repair = await streamByoReplyWithTools(
            byo,
            `PERINTAH PERBAIKAN — kamu diminta mendelegasikan pekerjaan ("${text.slice(0, 200)}") tapi kamu BELUM memanggil tool message_bot sama sekali. JANGAN percaya riwayat chat yang mengklaim delegasi sudah terkirim — riwayat itu bisa berisi karanganmu sendiri. Panggil message_bot SEKARANG dengan target bot yang benar (cek list_bots bila ragu) dan isi tugasnya persis seperti permintaan. Setelah tool mengembalikan hasil, laporkan hanya apa yang dikatakan hasil tool itu.`,
            {
              tools,
              execTool: execToolWithTimeout,
              systemPrompt,
              history: priorMessages
                .filter(
                  (m) =>
                    (m.role === 'user' || m.role === 'assistant') &&
                    m.text.trim().length > 0,
                )
                .map((m) => ({ role: m.role, content: m.text }))
                .concat([{ role: 'user', content: text }]),
              onDelta,
              onToolCall,
              abortSignal: controller.signal,
            },
          );
          res = repair;
        } catch {
          // Perbaikan gagal — hentikan loop, pakai hasil yang ada.
          break;
        }
        didDelegate = (res.toolCalls ?? []).some(
          (c) =>
            c.name === MESSAGE_BOT_TOOL_NAME ||
            c.name === HANDOFF_TO_BOT_TOOL_NAME,
        );
      }
      const finalText = res.text;
      usage = res.usage ?? null;
      host.updateMessages((prev) =>
        prev.map((m) => (m.id === streamId ? { ...m, text: finalText, streaming: false } : m)),
      );
      if (!controller.signal.aborted) {
        try {
          const savedAsst = await host.persistMessageWithRetry(roomId, host.characterId ?? null, finalText, 'assistant');
          if (savedAsst) {
            host.updateMessages((prev) =>
              prev.map((m) => (m.id === streamId ? { ...m, id: savedAsst.message.id, local: false } : m)),
            );
            host.setServerWarning(null);
          }
        } catch {
          // Sama seperti di atas — user harus tahu (0.10.12).
          host.setServerWarning(
            'Server tidak terjangkau — balasan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
          );
        }
        if (res.usage) {
          try {
            await recordCost({
              bot: host.characterId ?? roomId,
              taskId: newTaskId(),
              taskKind: 'chat',
              model: byo.model,
              usage: res.usage,
            });
          } catch {
            // Gagal mencatat cost tidak menggagalkan chat.
          }
        } else {
          // Fase 4(b): provider tanpa usage (Mercury) — catat
          // penanda 'tidak terukur', BUKAN nol palsu.
          try {
            await recordUnmeasuredCost({
              bot: host.characterId ?? roomId,
              taskId: newTaskId(),
              taskKind: 'chat',
              model: byo.model,
            });
          } catch {
            // Gagal mencatat cost tidak menggagalkan chat.
          }
        }
      }
      resultText = finalText;
    } else {
      // 2b. Tanpa BYO: balasan mock. Server SUDAH menyimpan pesan user
      // + balasan (POST /api/chat), jadi tidak ada persistMessage lagi.
      // Jalur mock butuh character yang valid: untuk room tanpa satu
      // bot, pakai anggota pertama room sebagai penjawab.
      // Runner TIDAK BOLEH mock: tanpa konfigurasi model, gagal jujur.
      if (!host.allowMock) {
        throw new Error('Runner tanpa konfigurasi model (BYO kosong) — turn dibatalkan, bukan dijawab mock.');
      }
      const res = await host.sendMock(roomId, who, text);
      host.setThinking(null);
      if (!res) {
        host.updateMessages((prev) => prev.filter((m) => m.id !== streamId && m.id !== userMsg.id));
        throw new Error('Server menjawab 401 — simpan access token dulu.');
      }
      if (controller.signal.aborted) {
        host.updateMessages((prev) => prev.filter((m) => m.id !== streamId));
      } else {
        host.updateMessages((prev) =>
          prev.map((m) => (m.id === userMsg.id ? { ...m, id: res.user_message.id, local: false } : m)),
        );
        host.runTypewriter(res.assistant_message.text, streamId, res.assistant_message.id);
        resultText = res.assistant_message.text;
        return { status: 'done', finalText: resultText, usage: null };
      }
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    // 0.10.14: catat status akhir untuk turnRunner.
    turnStatus = aborted ? 'stopped' : 'error';
    // 0.10.13: balasan PARSIAL yang sudah mengalir (via onDelta)
    // TETAP disimpan walau stream di-abort (STOP / keluar) atau
    // gagal (jaringan putus saat bot kerja).
    const partial = host.getStreamText(streamId)?.trim() ?? '';
    if (partial) {
      try {
        const savedAsst = await host.persistMessageWithRetry(roomId, host.characterId ?? null, partial, 'assistant');
        if (savedAsst) {
          host.updateMessages((prev) =>
            prev.map((m) =>
              m.id === streamId ? { ...m, id: savedAsst.message.id, local: false, streaming: false } : m,
            ),
          );
          host.setServerWarning(null);
        } else {
          host.updateMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m)));
        }
      } catch {
        host.updateMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m)));
        host.setServerWarning(
          'Server tidak terjangkau — balasan parsial ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
        );
      }
      resultText = partial;
    } else if (!aborted) {
      // 0.10.14: error tanpa teks parsial — SIMPAN ke server (retry),
      // bukan hanya tampil lokal.
      const errText =
        e instanceof Error ? e.message : 'Gagal mendapat balasan. Periksa koneksi lalu coba lagi.';
      host.updateMessages((prev) =>
        prev.map((m) =>
          m.id === streamId ? { ...m, text: m.text || errText, streaming: false } : m,
        ),
      );
      try {
        const savedErr = await host.persistMessageWithRetry(roomId, host.characterId ?? null, errText, 'assistant');
        if (savedErr) {
          host.updateMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, id: savedErr.message.id, local: false } : m)),
          );
          host.setServerWarning(null);
        }
      } catch {
        host.setServerWarning(
          'Server tidak terjangkau — balasan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
        );
      }
      resultText = errText;
    } else {
      // Abort tanpa teks parsial — hapus bubble kosong.
      host.updateMessages((prev) => prev.filter((m) => m.id !== streamId));
      resultText = null;
    }
    // TIDY3 cost marker: turn gagal (bukan abort) WAJIB meninggalkan
    // penanda biaya 'tidak terukur' (task_kind chat-failed, token null),
    // supaya turn gagal tidak lagi hilang dari ledger tanpa jejak.
    // Best-effort: gagal mencatat tidak menggagalkan turn.
    if (!aborted) {
      try {
        const failedByo = await getByo().catch(() => null);
        if (failedByo) {
          await recordUnmeasuredCost({
            bot: host.characterId ?? roomId,
            taskId: newTaskId(),
            taskKind: 'chat-failed',
            model: failedByo.model,
          });
        }
      } catch {
        // Penanda cost gagal — turn tetap selesai dengan error.
      }
    }
  } finally {
    setComputerLeaseId(prevLeaseId);
    host.setReplying(false);
    host.setThinking(null);
    host.setAbortController(null);
    // 0.10.14: tandai turn selesai di turnRunner — subscriber
    // me-reload dari server dan menampilkan balasan final.
    // No-op bila tidak ada turn terdaftar.
    completeTurn(roomId, turnStatus, turn.generation);
  }
  return { status: turnStatus, finalText: resultText, usage };
}
