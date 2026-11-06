/**
 * Runner-auto Fase 7 (31 Okt 2026, pola delegasi): delegasi yang
 * dieksekusi adalah RECORD SERVER (/api/delegations), bukan pesan
 * chat yang bisa hilang saat room dibuat ulang. Klaim dilakukan
 * di server (atomik — dua runner tidak bisa mengeksekusi record
 * yang sama), dan hasil balik diposting server ke room Chief.
 * Alasan arsitektur tetap: model BYO tinggal di HP, jadi runner
 * TIDAK BISA jalan murni di server — ia jalan di app selama ada
 * layar chat terbuka (foreground). Bila app di-background Android,
 * polling berhenti dan delegasi menunggu sampai app dibuka lagi.
 *
 * Alur per delegasi (sekali jalan, tanpa loop):
 *  1. Cari delegasi yang belum diklaim di semua room chat.
 *  2. Klaim dulu (AsyncStorage) SEBELUM menjalankan — klaim yang
 *     sudah jalan tidak boleh dieksekusi dua kali, walau app restart.
 *  3. Jalankan satu giliran model spesialis pakai BYO + browser tools
 *     SAJA (tanpa tool delegasi/bot/skill/kredensial — spesialis
 *     tidak boleh mendelegasikan lagi, supaya tidak ada loop
 *     bot-ke-bot tanpa ujung).
 *  4. Simpan hasil di room spesialis, lalu kirim
 *     "Hasil dari <Nama>:" ke room bot pengirim (Chief).
 *  5. Bila giliran gagal, kirim catatan gagal yang jujur ke room
 *     Chief — jangan diam, jangan klaim sukses.
 */

import { AppState } from 'react-native';
import { getByo, streamByoReplyWithTools, type ChatTool, type ParsedToolCall } from './byo';
import { setComputerLeaseId } from './teamComputer';
import { newTaskId } from './sendTurn';
import {
  claimDelegation,
  completeDelegation,
  getCharacters,
  getDelegations,
  persistMessageWithRetry,
  recordCost,
  recordUnmeasuredCost,
} from './client';
import { buildSystemPrompt } from './systemPrompt';
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

const POLL_MS = 25000;

const RUNNER_TOOLS: ChatTool[] = [
  OPEN_BROWSER_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_LIST_ELEMENTS_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_ZOOM_TOOL,
  WEB_SEARCH_TOOL,
  WEB_OPEN_TOOL,
  LIST_FILES_TOOL,
  READ_FILE_TOOL,
  GET_TEAM_MEMORY_TOOL,
  GET_TEAM_STATUS_TOOL,
  SAVE_TEAM_MEMORY_TOOL,
];

async function execRunnerTool(call: ParsedToolCall): Promise<string> {
  try {
    if (call.name === OPEN_BROWSER_TOOL_NAME) return await executeOpenBrowserTool(call);
    if (call.name === BROWSER_CLICK_TOOL_NAME) return await executeBrowserClickTool(call);
    if (call.name === BROWSER_LIST_ELEMENTS_TOOL_NAME) return await executeBrowserListElementsTool(call);
    if (call.name === BROWSER_TYPE_TOOL_NAME) return await executeBrowserTypeTool(call);
    if (call.name === BROWSER_SCROLL_TOOL_NAME) return await executeBrowserScrollTool(call);
    if (call.name === BROWSER_ZOOM_TOOL_NAME) return await executeBrowserZoomTool(call);
    if (call.name === WEB_SEARCH_TOOL_NAME) return await executeWebSearchTool(call);
    if (call.name === WEB_OPEN_TOOL_NAME) return await executeWebOpenTool(call);
    if (call.name === LIST_FILES_TOOL_NAME || call.name === READ_FILE_TOOL_NAME) return await executeFileTool(call);
    if (call.name === GET_TEAM_MEMORY_TOOL_NAME || call.name === GET_TEAM_STATUS_TOOL_NAME || call.name === SAVE_TEAM_MEMORY_TOOL_NAME) return await executeTeamTool(call);
  } catch (e) {
    return `Terjadi error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return 'Tool itu tidak dikenal oleh runner.';
}

/** Satu putaran polling: ambil record queued, klaim di server, jalankan. */
export async function pollRunnerOnce(): Promise<string | null> {
  if (AppState.currentState !== 'active') return null;
  setComputerLeaseId(null);
  const byo = await getByo().catch(() => null);
  if (!byo) return null;
  const queued = await getDelegations('queued').catch(() => null);
  if (!queued || queued.length === 0) return null;
  const characters = await getCharacters().catch(() => null);
  if (!characters) return null;
  for (const rec of queued) {
    // Klaim server atomik: kalah klaim = lewati, bukan eksekusi ganda.
    const claimed = await claimDelegation(rec.id).catch(() => null);
    if (!claimed) continue;
    setComputerLeaseId(`dlg:${rec.id}`);
    const target = characters.find((c) => c.id === rec.target);
    if (!target) {
      await completeDelegation(
        rec.id,
        undefined,
        `Bot tujuan ${rec.target} tidak ditemukan di server.`,
      ).catch(() => null);
      setComputerLeaseId(null);
      continue;
    }
    let resultText = '';
    try {
      const systemPrompt = buildSystemPrompt(target, target.name, {
        sandboxAvailable: false,
        botToolsAvailable: false,
        skillToolsAvailable: false,
        mcpToolsAvailable: false,
      });
      // Percobaan ulang (Fase 8 pola reconciler; Fase 9: 429 ikut
      // transient): galat jaringan sesaat dan rate-limit (HTTP 429)
      // tidak boleh langsung mematikan record. Maks 3x,
      // jeda 20 dtk antar percobaan; galat non-transient langsung
      // dilempar ke penangan gagal di bawah.
      let res = null as Awaited<
        ReturnType<typeof streamByoReplyWithTools>
      > | null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          res = await streamByoReplyWithTools(byo, rec.message, {
            tools: RUNNER_TOOLS,
            execTool: execRunnerTool,
            systemPrompt,
            history: null,
          });
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const transient = /network error|timed out|Model API request failed|429|rate limit|too many requests/i.test(msg);
          if (!transient || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 20000));
        }
      }
      resultText = (res?.text ?? '').trim();
      // Fase 4(b): catat biaya spesialis — terukur bila ada
      // usage, penanda 'tidak terukur' bila tidak (Mercury).
      // Best-effort; pencatatan tidak boleh menggagalkan relay.
      try {
        if (res?.usage) {
          await recordCost({
            bot: rec.target,
            taskId: newTaskId(),
            taskKind: 'delegation',
            model: byo.model,
            usage: res.usage,
          });
        } else {
          await recordUnmeasuredCost({
            bot: rec.target,
            taskId: newTaskId(),
            taskKind: 'delegation',
            model: byo.model,
          });
        }
      } catch {
        // Abaikan — pencatatan cost tidak boleh menggagalkan relay.
      }
    } catch (e) {
      const failNote =
        `Runner gagal menjalankan tugas untuk ${target.name}: ` +
        `${e instanceof Error ? e.message : String(e)}`;
      await persistMessageWithRetry(
        rec.target_room,
        target.id,
        failNote,
        'assistant',
      ).catch(() => null);
      await completeDelegation(rec.id, undefined, failNote).catch(() => null);
      setComputerLeaseId(null);
      return target.id;
    }
    if (!resultText) {
      resultText = '(Spesialis tidak mengembalikan teks apa pun.)';
    }
    await persistMessageWithRetry(
      rec.target_room,
      target.id,
      resultText,
      'assistant',
    ).catch(() => null);
    // Hasil balik diposting server ke room Chief (complete).
    await completeDelegation(rec.id, resultText).catch(() => null);
    setComputerLeaseId(null);
    // Satu delegasi per putaran — putaran berikutnya menangani sisanya.
    return target.id;
  }
  return null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Mulai polling runner-auto. Mengembalikan fungsi stop. */
export function startRunnerAuto(): () => void {
  if (timer) return () => stopRunnerAuto();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollRunnerOnce();
    } catch {
      // Polling tidak boleh meledakkan layar chat.
    } finally {
      running = false;
    }
  };
  void tick();
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  return () => stopRunnerAuto();
}

export function stopRunnerAuto(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
