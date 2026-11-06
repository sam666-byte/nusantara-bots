/**
 * Team Computer (0.10.0, bagian F).
 *
 * Layar komputer tim: browser di PC yang dipakai bot, tampil LIVE
 * di aplikasi sebagai screenshot yang di-refresh, dan bisa diambil
 * alih pengguna ("Take control").
 *
 * Kejujuran layar (pelajaran screenshot Sam yang HITAM/kosong):
 * endpoint screen mengembalikan {available:false, reason} bila
 * browser/display belum jalan — aplikasi menampilkan ALASAN itu,
 * bukan kotak hitam yang pura-pura live. Gambar hanya ditampilkan
 * bila available=true.
 *
 * Scope: "team" = komputer tim (dipakai bersama), "private" =
 * komputer privat bot itu. Toggle di layar mengganti scope yang
 * ditampilkan — dua sesi terpisah di server.
 *
 * Semua fungsi fail-soft (null/false) kecuali yang dipakai form
 * kontrol — pemanggil menampilkan pesan server apa adanya.
 */

import { apiFetch, apiFetchTimeout, getServerUrl } from './client';

/** Port noVNC di PC (0.10.13): websockify melayani desktop :100
 * (Chromium yang sama dengan mirror) sebagai halaman web VNC. */
export const NOVNC_PORT = 6081;

/**
 * URL noVNC untuk browser bersama (0.10.13).
 *
 * Ini jawaban atas permintaan Sam "browser nya cara Lo bisa kita
 * take over biar gw bisa masuk": browser yang SAMA dipakai dua arah
 * — Muse mengendalikannya lewat tool/CDP (open_browser,
 * browser_click, browser_type) DAN Sam memasukinya langsung dari HP
 * lewat VNC interaktif (bukan lagi sekadar mirror gambar + tap).
 * Host diambil dari server URL yang dipakai aplikasi, jadi VNC
 * mengikuti koneksi yang sedang aktif. `autoconnect` = langsung
 * tersambung, `resize=scale` = desktop menyesuaikan layar HP.
 */
export async function getNovncUrl(): Promise<string> {
  const base = await getServerUrl();
  const host = base.replace(/^https?:\/\//, '').split(':')[0].split('/')[0] || 'YOUR_SERVER';
  return `http://${host}:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&show_dot=true`;
}

/** Batas waktu fetch layar/status (0.10.8): fetch yang menggantung
 * lebih lama dari ini dibatalkan supaya poll mirror tidak macet
 * selamanya (fetch polos tanpa timeout = mirror beku di frame lama). */
export const COMPUTER_FETCH_TIMEOUT_MS = 8000;

export type ComputerScope = 'team' | 'private';

export interface ComputerStatus {
  scope: ComputerScope;
  using_bot: { id: string; name: string } | null;
  controlled_by: 'bot' | 'user';
  browser_open: boolean;
  url: string | null;
  screen_available: boolean;
  screen_reason: string | null;
  screen_age_seconds: number | null;
}

export interface ComputerScreenShot {
  available: boolean;
  reason: string | null;
  image_b64: string | null;
  width: number | null;
  height: number | null;
  age_seconds: number | null;
}

/** GET /api/computer/status?scope= — fail-soft null. Timeout 8 dtk
 * (0.10.8): fetch menggantung tidak boleh membekukan poll mirror. */
export async function getComputerStatus(scope: ComputerScope): Promise<ComputerStatus | null> {
  try {
    const res = await apiFetchTimeout(`/api/computer/status?scope=${scope}`, COMPUTER_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as ComputerStatus;
  } catch {
    return null;
  }
}

/** GET /api/computer/screen?scope= — fail-soft: gagal = tidak tersedia + alasan. Timeout 8 dtk (0.10.8). */
export async function getComputerScreen(scope: ComputerScope): Promise<ComputerScreenShot> {
  try {
    const res = await apiFetchTimeout(`/api/computer/screen?scope=${scope}`, COMPUTER_FETCH_TIMEOUT_MS);
    if (!res.ok) return { available: false, reason: 'Server tidak menjawab.', image_b64: null, width: null, height: null, age_seconds: null };
    const data = (await res.json()) as ComputerScreenShot;
    if (!data) return { available: false, reason: 'Server tidak menjawab.', image_b64: null, width: null, height: null, age_seconds: null };
    return {
      available: data.available === true,
      reason: typeof data.reason === 'string' ? data.reason : null,
      image_b64: typeof data.image_b64 === 'string' ? data.image_b64 : null,
      width: typeof data.width === 'number' ? data.width : null,
      height: typeof data.height === 'number' ? data.height : null,
      age_seconds: typeof data.age_seconds === 'number' ? data.age_seconds : null,
    };
  } catch {
    return { available: false, reason: 'Server tidak menjawab.', image_b64: null, width: null, height: null, age_seconds: null };
  }
}

/** Lease komputer per turn (Langkah 2 fase 4): id turn yang
 * sedang memegang scope — diset runner (srv:<id>) /
 * runnerAuto (dlg:<id>) / sendTurn (app:<...> per invokasi).
 * null = jalur lama tanpa lease. Dikirim sebagai turn_id
 * di semua POST aksi komputer (JSON.stringify membuang
 * undefined, jadi null = field tidak terkirim = legacy).
 */
let computerLeaseId: string | null = null;
export function setComputerLeaseId(id: string | null): string | null {
  const prev = computerLeaseId;
  computerLeaseId = id;
  return prev;
}

/** POST /api/computer/open — buka browser di scope itu (opsional URL). */
export async function openComputerBrowser(
  scope: ComputerScope,
  url?: string,
  botId?: string,
  actor: 'user' | 'bot' = 'user',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/computer/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, url: url ?? null, bot_id: botId ?? null, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/take-control — pengguna mengambil alih (bot dijeda). */
export async function takeControl(scope: ComputerScope): Promise<{ ok: boolean; error?: string }> {
  return postControl(`/api/computer/take-control`, scope);
}

/** POST /api/computer/release-control — kembalikan ke bot. */
export async function releaseControl(scope: ComputerScope): Promise<{ ok: boolean; error?: string }> {
  return postControl(`/api/computer/release-control`, scope);
}

async function postControl(path: string, scope: ComputerScope): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/click — klik di layar (x,y ternormalisasi 0..1). actor 'bot' untuk tool bot, 'user' untuk layar. */
export async function clickComputer(
  scope: ComputerScope,
  x: number,
  y: number,
  actor: 'user' | 'bot' = 'user',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/computer/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, x, y, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/type — ketik ke elemen yang fokus. actor 'bot' untuk tool bot, 'user' untuk layar. */
export async function typeComputer(
  scope: ComputerScope,
  text: string,
  actor: 'user' | 'bot' = 'user',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/computer/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, text, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/scroll (0.10.7) — scroll halaman. actor 'bot' untuk tool bot, 'user' untuk layar. */
export async function scrollComputer(
  scope: ComputerScope,
  direction: 'down' | 'up',
  amount = 3,
  actor: 'user' | 'bot' = 'user',
  x?: number,
  y?: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/computer/scroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, direction, amount, x, y, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/zoom (0.10.7) — zoom halaman (Ctrl+plus/minus/0). actor 'bot' untuk tool bot, 'user' untuk layar. */
export async function zoomComputer(
  scope: ComputerScope,
  direction: 'in' | 'out' | 'reset',
  actor: 'user' | 'bot' = 'user',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/computer/zoom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, direction, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** Satu elemen klik dari browser_list_elements (0.10.8). x/y adalah
 * koordinat VIEWPORT 0..1 (bukan layar) — dipakai browser_click. */
export interface BrowserElement {
  tag: string;
  label: string;
  href: string;
  x: number;
  y: number;
}

export interface BrowserElementList {
  ok: boolean;
  url: string | null;
  title: string | null;
  count: number;
  below_fold: number;
  elements: BrowserElement[];
  error?: string;
}

/** POST /api/computer/list-elements (0.10.8) — daftar elemen yang
 * bisa diklik di tab aktif + koordinat viewport 0..1. Grounding
 * visual berbasis TEKS: model text-only tidak bisa melihat
 * screenshot, jadi ia memilih elemen dari daftar ini lalu
 * browser_click ke (x, y)-nya. Fail-soft: gagal = ok:false + error. */
export async function listElementsComputer(
  scope: ComputerScope,
  actor: 'user' | 'bot' = 'user',
): Promise<BrowserElementList> {
  try {
    const res = await apiFetchTimeout('/api/computer/list-elements', COMPUTER_FETCH_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, url: null, title: null, count: 0, below_fold: 0, elements: [], error: await readError(res) };
    const data = (await res.json()) as {
      ok?: unknown; url?: unknown; title?: unknown; count?: unknown;
      below_fold?: unknown; elements?: unknown;
    };
    const raw = Array.isArray(data.elements) ? data.elements : [];
    const elements: BrowserElement[] = [];
    for (const el of raw) {
      if (!el || typeof el !== 'object') continue;
      const e = el as Record<string, unknown>;
      const x = typeof e.x === 'number' ? e.x : Number(e.x);
      const y = typeof e.y === 'number' ? e.y : Number(e.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      elements.push({
        tag: typeof e.tag === 'string' ? e.tag : '',
        label: typeof e.label === 'string' ? e.label : '',
        href: typeof e.href === 'string' ? e.href : '',
        x, y,
      });
    }
    return {
      ok: data.ok === true,
      url: typeof data.url === 'string' ? data.url : null,
      title: typeof data.title === 'string' ? data.title : null,
      count: elements.length,
      below_fold: typeof data.below_fold === 'number' ? data.below_fold : 0,
      elements,
    };
  } catch {
    return { ok: false, url: null, title: null, count: 0, below_fold: 0, elements: [], error: 'Server tidak menjawab.' };
  }
}

/** POST /api/computer/click-viewport (0.10.8) — klik model di
 * koordinat VIEWPORT 0..1 (dari browser_list_elements) via CDP.
 * Berbeda dari clickComputer (tap layar Team Computer, koordinat
 * layar via xdotool): klik ini memakai ruang CSS px viewport yang
 * sama dengan getBoundingClientRect, jadi mengenai target meski
 * DPR != 1. actor 'bot' untuk tool bot, 'user' untuk layar. */
export async function clickViewportComputer(
  scope: ComputerScope,
  x: number,
  y: number,
  actor: 'user' | 'bot' = 'user',
): Promise<{ ok: boolean; error?: string; url?: string }> {
  try {
    const res = await apiFetch('/api/computer/click-viewport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, x, y, actor, turn_id: computerLeaseId ?? undefined }),
    });
    if (!res.ok) return { ok: false, error: await readError(res) };
    const data = (await res.json()) as { url?: unknown };
    return { ok: true, url: typeof data.url === 'string' ? data.url : undefined };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    /* bukan JSON */
  }
  return `Server menolak (HTTP ${res.status}).`;
}

/** Label status pemakai untuk layar ("New Bot is using it" / "Kamu mengendalikan"). */
export function usingLabel(status: ComputerStatus | null): string {
  if (!status) return 'Status komputer tidak terbaca.';
  if (status.controlled_by === 'user') return 'Kamu mengendalikan komputer ini — bot dijeda.';
  if (status.using_bot) return `${status.using_bot.name} is using it`;
  if (status.browser_open) return 'Browser terbuka — belum ada bot yang memakai.';
  return 'Browser belum dibuka.';
}

/** Riset spek (jalur tes): pencarian server-side tanpa API key. */
export async function searchWeb(
  query: string,
): Promise<{
  ok: boolean;
  results?: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
}> {
  try {
    const res = await apiFetch(`/api/research/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return { ok: false, error: await readError(res) };
    return (await res.json()) as {
      ok: boolean;
      results?: Array<{ title: string; url: string; snippet: string }>;
    };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}

/** Riset spek (jalur tes): baca halaman sumber jadi teks. */
export async function openWebPage(
  url: string,
): Promise<{ ok: boolean; text?: string; chars?: number; error?: string }> {
  try {
    const res = await apiFetch(`/api/research/open?url=${encodeURIComponent(url)}`);
    if (!res.ok) return { ok: false, error: await readError(res) };
    return (await res.json()) as { ok: boolean; text?: string; chars?: number };
  } catch {
    return { ok: false, error: 'Server tidak menjawab.' };
  }
}
