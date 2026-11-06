/**
 * Tool buka browser untuk chat BYO (0.10.0, bagian H — auto-open
 * pola referensi).
 *
 * Aturan yang mengikat (pelajaran dari aplikasi lain yang Sam
 * bandingkan):
 * - Bila pengguna meminta membuka/masuk ke suatu layanan, bot
 *   LANGSUNG buka browser ke URL target — JANGAN bertanya dulu
 *   "mau aku buka?". Tool ini yang dipakai untuk itu.
 * - Browser HARUS terbuka LANGSUNG ke URL target (bukan tab kosong):
 *   eksekutor selalu mengirim `url` ke POST /api/computer/open;
 *   server yang tidak menavigasi ke URL itu adalah bug server.
 * - Gagal = lapor alasan SPESIFIK dari server (mis. "browser belum
 *   terhubung"), JANGAN error generik "tool operations failed".
 * - Eksekutor TIDAK PERNAH throw (semua kegagalan jadi teks hasil
 *   tool yang jujur — sama seperti vm_exec / bot tools).
 */

import { clickViewportComputer, listElementsComputer, openComputerBrowser, openWebPage, scrollComputer, searchWeb, typeComputer, zoomComputer } from './teamComputer';
import type { ChatTool, ParsedToolCall } from './byo';

export const OPEN_BROWSER_TOOL_NAME = 'open_browser';

export const OPEN_BROWSER_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: OPEN_BROWSER_TOOL_NAME,
    description:
      'Buka browser komputer LANGSUNG ke satu URL (mis. https://studio.youtube.com). Pakai tool ini SEGERA bila pengguna meminta membuka atau masuk/login ke suatu layanan — JANGAN bertanya dulu "mau aku buka?". Selalu berikan URL lengkap targetnya; browser dibuka ke URL itu, bukan tab kosong. Bila gagal, laporkan alasan persisnya dari hasil tool — jangan mengklaim browser terbuka.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL lengkap yang dibuka, mis. "https://studio.youtube.com".',
        },
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (default, komputer tim) atau "private" (komputer privat bot).',
        },
      },
      required: ['url'],
    },
  },
};

/**
 * Eksekutor open_browser — membuka browser ke URL target via
 * POST /api/computer/open. TIDAK PERNAH throw.
 */
export async function executeOpenBrowserTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen open_browser tidak valid (bukan JSON objek). Berikan url sebagai string.';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\/\S+$/.test(url)) {
    return 'open_browser gagal: url harus berupa URL lengkap http(s) (mis. "https://studio.youtube.com"). Browser TIDAK dibuka — jangan mengklaim browser terbuka.';
  }
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await openComputerBrowser(scope, url, undefined, 'bot');
  if (!result.ok) {
    const reason = result.error ?? 'server tidak menjawab.';
    return `Browser GAGAL dibuka ke ${url}: ${reason} Jangan mengklaim browser terbuka — laporkan alasan ini ke pengguna.`;
  }
  return (
    `Browser dibuka ke ${url} (komputer ${scope === 'team' ? 'tim' : 'privat'}). ` +
    `Layarnya tampil live di Team Computer — pengguna bisa melihatnya dan mengambil alih dengan Take control.`
  );
}

// ---------------------------------------------------------------------------
// Kontrol browser penuh (0.10.7, permintaan Sam: browser bot seperti
// browser Muse — klik, ketik, scroll, zoom; bukan cuma buka URL).
//
// Semua eksekutor TIDAK PERNAH throw (kegagalan jadi teks hasil tool
// yang jujur, seperti open_browser / vm_exec). Semua memanggil server
// sebagai actor 'bot' — bekerja saat bot memegang kendali (default);
// bila pengguna sedang Take control, server menolak dengan jelas
// (409) dan model harus melaporkannya, bukan mengklaim berhasil.
// ---------------------------------------------------------------------------

export const BROWSER_CLICK_TOOL_NAME = 'browser_click';

export const BROWSER_CLICK_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: BROWSER_CLICK_TOOL_NAME,
    description:
      'Klik di browser komputer pada posisi (x, y) dari daftar browser_list_elements — koordinat VIEWPORT 0..1 (bukan layar). WAJIB panggil browser_list_elements dulu dan pilih elemen dari daftarnya; JANGAN PERNAH menebak koordinat dari ingatan layout halaman (tebakan meleset — itu bug 0.10.7). Klik dilakukan via CDP di ruang viewport yang sama dengan daftar elemen, jadi mengenai target. Setelah klik, panggil browser_list_elements lagi untuk melihat halaman hasil klik.',
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Posisi horizontal 0..1 dari browser_list_elements (0 = kiri viewport, 1 = kanan).',
        },
        y: {
          type: 'number',
          description: 'Posisi vertikal 0..1 dari browser_list_elements (0 = atas viewport, 1 = bawah).',
        },
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (default, komputer tim) atau "private" (komputer privat bot).',
        },
      },
      required: ['x', 'y'],
    },
  },
};

/** Eksekutor browser_click — klik via POST /api/computer/click-viewport (CDP, actor bot). TIDAK PERNAH throw. */
export async function executeBrowserClickTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen browser_click tidak valid (bukan JSON objek). Berikan x dan y sebagai angka 0..1.';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const x = typeof args.x === 'number' ? args.x : Number(args.x);
  const y = typeof args.y === 'number' ? args.y : Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return 'browser_click gagal: x dan y harus angka 0..1 (mis. x 0.5, y 0.35). Klik TIDAK dilakukan — jangan mengklaim berhasil.';
  }
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await clickViewportComputer(scope, x, y, 'bot');
  if (!result.ok) {
    return `browser_click gagal: ${result.error ?? 'server tidak menjawab.'} Klik TIDAK dilakukan — laporkan alasan ini ke pengguna.`;
  }
  return (
    `Browser diklik di (${x}, ${y}).` +
    (result.url ? ` Halaman sekarang: ${result.url}.` : '') +
    ` Panggil browser_list_elements lagi untuk melihat isi halaman hasil klik sebelum langkah berikutnya.`
  );
}

// ---------------------------------------------------------------------------
// Grounding visual berbasis TEKS (0.10.8, perbaikan CLICK BUTA).
//
// Model DeepSeek V3 text-only TIDAK BISA melihat screenshot, jadi ia
// tidak boleh menebak koordinat klik dari ingatan layout (itu yang
// membuat klik meleset 2x di 0.10.7). Tool ini mengembalikan daftar
// elemen yang bisa diklik di tab aktif beserta koordinat VIEWPORT
// 0..1-nya (diambil server dari DOM via CDP getBoundingClientRect).
// Model WAJIB memanggil tool ini dulu, memilih elemen dari daftar,
// lalu browser_click ke (x, y) elemen itu. Bila target belum ada di
// daftar (mis. hasil pencarian masih di bawah lipatan), scroll dulu
// (browser_scroll) lalu panggil tool ini lagi.
// ---------------------------------------------------------------------------

export const BROWSER_LIST_ELEMENTS_TOOL_NAME = 'browser_list_elements';

export const BROWSER_LIST_ELEMENTS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: BROWSER_LIST_ELEMENTS_TOOL_NAME,
    description:
      'Daftar elemen yang bisa diklik di halaman browser aktif beserta koordinat VIEWPORT-nya (x, y 0..1). WAJIB dipanggil SEBELUM browser_click — pilih elemen dari daftar ini dan klik koordinatnya; JANGAN PERNAH menebak koordinat. Bila target (mis. hasil pencarian pertama) belum ada di daftar, scroll ke bawah (browser_scroll down) lalu panggil tool ini lagi. Daftar hanya berisi elemen yang terlihat di viewport; "below_fold" = jumlah elemen klik di bawah lipatan yang belum terlihat. WAJIB sertakan argumen {"scope": "team"} (atau "private" bila komputer privat) — JANGAN PERNAH panggil tool ini tanpa argumen.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (komputer tim) atau "private" (komputer privat bot). WAJIB diisi, contoh: {"scope": "team"}.',
        },
      },
      required: ['scope'],
    },
  },
};

/** Eksekutor browser_list_elements — daftar elemen via POST /api/computer/list-elements (actor bot). TIDAK PERNAH throw. */
export async function executeBrowserListElementsTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen browser_list_elements tidak valid (bukan JSON objek).';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await listElementsComputer(scope, 'bot');
  if (!result.ok) {
    return `browser_list_elements gagal: ${result.error ?? 'server tidak menjawab.'} Daftar elemen TIDAK didapat — jangan menebak koordinat; laporkan alasan ini ke pengguna.`;
  }
  if (result.elements.length === 0) {
    return `Halaman ${result.url ?? '(tidak diketahui)'}: tidak ada elemen yang bisa diklik di viewport saat ini.` +
      (result.below_fold > 0 ? ` Ada ${result.below_fold} elemen lagi di bawah lipatan — scroll ke bawah lalu panggil browser_list_elements lagi.` : ' Coba scroll atau buka halaman lain.');
  }
  const lines = result.elements.map((el, i) => {
    const label = el.label ? ` "${el.label}"` : '';
    const href = el.href ? ` -> ${el.href}` : '';
    return `${i + 1}. [${el.tag}]${label} (x=${el.x}, y=${el.y})${href}`;
  });
  let out = `Halaman: ${result.title ?? ''} ${result.url ?? ''}\nElemen yang bisa diklik (${result.count}):\n${lines.join('\n')}`;
  if (result.below_fold > 0) {
    out += `\nAda ${result.below_fold} elemen lagi di bawah lipatan — bila target belum ada di daftar, scroll ke bawah (browser_scroll down) lalu panggil browser_list_elements lagi.`;
  }
  out += '\nPilih elemen dari daftar ini dan klik koordinat (x, y)-nya dengan browser_click. Jangan menebak koordinat di luar daftar.';
  return out;
}

export const BROWSER_TYPE_TOOL_NAME = 'browser_type';

export const BROWSER_TYPE_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: BROWSER_TYPE_TOOL_NAME,
    description:
      'Ketik teks ke elemen yang sedang fokus di browser komputer (mis. kotak pencarian Google — biasanya sudah fokus saat halaman dibuka). Pakai submit=true untuk menekan Enter setelah mengetik (mis. mengirim pencarian). Jangan dipakai untuk password — untuk login pakai tool login_service.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Teks yang diketik, mis. "jadwal sholat".',
        },
        submit: {
          type: 'boolean',
          description: 'Bila true, tekan Enter setelah mengetik (untuk mengirim pencarian / form).',
        },
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (default) atau "private".',
        },
      },
      required: ['text'],
    },
  },
};

/** Eksekutor browser_type — ketik via POST /api/computer/type (actor bot). TIDAK PERNAH throw. */
export async function executeBrowserTypeTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen browser_type tidak valid (bukan JSON objek). Berikan text sebagai string.';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  let text = typeof args.text === 'string' ? args.text : '';
  if (!text) {
    return 'browser_type gagal: text tidak boleh kosong.';
  }
  // submit = tekan Enter: newline di akhir string diketik xdotool
  // sebagai Return, jadi form/pencarian terkirim.
  if (args.submit === true) text += '\n';
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await typeComputer(scope, text, 'bot');
  if (!result.ok) {
    return `browser_type gagal: ${result.error ?? 'server tidak menjawab.'} Teks TIDAK diketik — laporkan alasan ini ke pengguna.`;
  }
  return `Teks diketik ke browser${args.submit === true ? ' dan Enter ditekan' : ''}. Layarnya tampil live di Team Computer — cek hasilnya di sana sebelum langkah berikutnya.`;
}

export const BROWSER_SCROLL_TOOL_NAME = 'browser_scroll';

export const BROWSER_SCROLL_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: BROWSER_SCROLL_TOOL_NAME,
    description:
      'Scroll halaman browser ke bawah ("down") atau ke atas ("up"). amount = jumlah putaran roda (1..10, default 3). Pakai untuk melihat isi halaman yang berada di bawah/atas layar.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: '"down" (default) atau "up".',
        },
        amount: {
          type: 'number',
          description: 'Jumlah putaran roda 1..10 (default 3).',
        },
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (default) atau "private".',
        },
      },
      required: ['direction'],
    },
  },
};

/** Eksekutor browser_scroll — scroll via POST /api/computer/scroll (actor bot). TIDAK PERNAH throw. */
export async function executeBrowserScrollTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen browser_scroll tidak valid (bukan JSON objek). Berikan direction "down" atau "up".';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const direction = args.direction === 'up' ? 'up' : 'down';
  const rawAmount = typeof args.amount === 'number' ? args.amount : Number(args.amount);
  const amount = Number.isFinite(rawAmount) ? Math.max(1, Math.min(10, Math.round(rawAmount))) : 3;
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await scrollComputer(scope, direction, amount, 'bot');
  if (!result.ok) {
    return `browser_scroll gagal: ${result.error ?? 'server tidak menjawab.'} Halaman TIDAK di-scroll — laporkan alasan ini ke pengguna.`;
  }
  return `Halaman browser di-scroll ke ${direction === 'down' ? 'bawah' : 'atas'} (${amount} putaran). Layarnya tampil live di Team Computer — cek hasilnya di sana.`;
}

export const BROWSER_ZOOM_TOOL_NAME = 'browser_zoom';

export const BROWSER_ZOOM_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: BROWSER_ZOOM_TOOL_NAME,
    description:
      'Zoom halaman browser: "in" memperbesar (Ctrl+plus), "out" memperkecil (Ctrl+minus), "reset" kembali ke 100% (Ctrl+0). Pakai bila teks/gambar terlalu kecil untuk dibaca di layar.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: '"in" (perbesar), "out" (perkecil), atau "reset" (kembali 100%).',
        },
        scope: {
          type: 'string',
          description: 'Sesi komputer: "team" (default) atau "private".',
        },
      },
      required: ['direction'],
    },
  },
};

/** Eksekutor browser_zoom — zoom via POST /api/computer/zoom (actor bot). TIDAK PERNAH throw. */
export async function executeBrowserZoomTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen browser_zoom tidak valid (bukan JSON objek). Berikan direction "in", "out", atau "reset".';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const direction = args.direction === 'out' ? 'out' : args.direction === 'reset' ? 'reset' : 'in';
  const scope = args.scope === 'private' ? 'private' : 'team';
  const result = await zoomComputer(scope, direction, 'bot');
  if (!result.ok) {
    return `browser_zoom gagal: ${result.error ?? 'server tidak menjawab.'} Zoom TIDAK berubah — laporkan alasan ini ke pengguna.`;
  }
  return `Zoom browser ${direction === 'in' ? 'diperbesar' : direction === 'out' ? 'diperkecil' : 'direset ke 100%'}. Layarnya tampil live di Team Computer — cek hasilnya di sana.`;
}

// ---------------------------------------------------------------------------
// Riset spek (jalur tes): web_search + web_open (server-side, tanpa API key).
// WAJIB dipakai dulu untuk tugas riset, sebelum menjawab apa pun.
// Eksekutor TIDAK PERNAH throw (kegagalan jadi teks hasil tool yang jujur).
// ---------------------------------------------------------------------------

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WEB_SEARCH_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      'Cari di web lewat server (tanpa API key) dan kembalikan daftar hasil: judul, URL, cuplikan. WAJIB dipanggil DULU untuk SEMUA tugas riset (riset, research, data terverifikasi) sebelum menulis jawaban apa pun — jangan menjawab riset dari ingatan. Sesudah search, buka sumber-sumbernya dengan web_open, lalu di jawaban final KUTIP URL sumber yang kamu buka. Bila search mengembalikan nol hasil atau gagal, laporkan riset gagal dengan jujur — jangan mengarang data.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Kata kunci pencarian, mis. "produk digital terlaris Indonesia 2024".',
        },
      },
      required: ['query'],
    },
  },
};

export async function executeWebSearchTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen web_search tidak valid (bukan JSON objek). Berikan query sebagai string.';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return 'web_search gagal: query kosong. Berikan kata kunci pencarian.';
  }
  const result = await searchWeb(query);
  if (!result.ok || !result.results) {
    const reason = result.error ?? 'server tidak menjawab.';
    return `web_search GAGAL untuk "${query}": ${reason} Jangan mengarang hasil — laporkan pencarian gagal dengan jujur.`;
  }
  if (result.results.length === 0) {
    return `web_search untuk "${query}" tidak mengembalikan hasil apa pun. Jangan mengarang data — laporkan pencarian gagal dengan jujur, atau coba query lain.`;
  }
  const lines = result.results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
  );
  return (
    `Hasil pencarian untuk "${query}" (${result.results.length} hasil, buka sumbernya dengan web_open sebelum menjawab):\n` +
    lines.join('\n')
  );
}

export const WEB_OPEN_TOOL_NAME = 'web_open';

export const WEB_OPEN_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: WEB_OPEN_TOOL_NAME,
    description:
      'Baca halaman sumber dari URL hasil web_search dan kembalikan teksnya. Pakai tool ini untuk SETIAP sumber yang akan kamu kutip — klaim faktual di jawaban final WAJIB terikat ke URL yang sudah kamu buka dengan tool ini. Bila halaman gagal dibuka, laporkan URL itu sebagai gagal dibuka — jangan mengarang isinya.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL lengkap dari hasil web_search.',
        },
      },
      required: ['url'],
    },
  },
};

export async function executeWebOpenTool(call: ParsedToolCall): Promise<string> {
  if (!call.argsValid) {
    return 'Argumen web_open tidak valid (bukan JSON objek). Berikan url sebagai string.';
  }
  const args = (call.args ?? {}) as Record<string, unknown>;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\/\S+$/.test(url)) {
    return 'web_open gagal: url harus berupa URL lengkap http(s) dari hasil web_search.';
  }
  const result = await openWebPage(url);
  if (!result.ok || typeof result.text !== 'string') {
    const reason = result.error ?? 'server tidak menjawab.';
    return `web_open GAGAL untuk ${url}: ${reason} Jangan mengarang isi halaman ini — laporkan sebagai gagal dibuka.`;
  }
  return `Isi halaman ${url} (${result.chars ?? result.text.length} karakter):\n${result.text}`;
}
