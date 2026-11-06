import { buildSystemPrompt } from '../systemPrompt';
import type { Character } from '../types';

const XMAN: Character = {
  id: 'chief-officer',
  name: 'Chief Officer',
  role: 'Kepala tim channel YouTube Jejak Hikmah',
  skills: ['team-memory', 'bot-live-presence'],
  memory_scope: 'team',
  summary: 'Mengkoordinasi bot tim dan menjaga arah channel.',
};

describe('buildSystemPrompt', () => {
  it('identifies the bot by name, role, summary and skills', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('Kamu Xman.');
    expect(prompt).toContain('Peranmu: Kepala tim channel YouTube Jejak Hikmah.');
    expect(prompt).toContain('Mengkoordinasi bot tim dan menjaga arah channel.');
    expect(prompt).toContain('Keahlianmu: team-memory, bot-live-presence.');
  });

  it('answers in the user language and stays honest', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('bahasa Indonesia');
    expect(prompt).toContain('bila kamu tidak tahu, katakan tidak tahu');
  });

  it('never claims code execution, sandbox, or device control', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    // Baris penjaga: melarang klaim itu (bukan mengklaimnya).
    expect(prompt).toContain('jangan mengklaim bisa menjalankan kode');
    expect(prompt).not.toMatch(/kamu bisa (menjalankan kode|mengakses sandbox|mengendalikan perangkat)/);
    expect(prompt).not.toContain('kamu dapat mengeksekusi');
  });

  it('uses character.name when no display name is given', () => {
    expect(buildSystemPrompt(XMAN)).toContain('Kamu Chief Officer.');
  });

  it('omits empty parts (no summary, no skills)', () => {
    const bare: Character = {
      id: 'bot-1',
      name: 'Bot Satu',
      role: 'Penulis',
      skills: [],
      memory_scope: 'team',
    };
    const prompt = buildSystemPrompt(bare);
    expect(prompt).toContain('Kamu Bot Satu.');
    expect(prompt).toContain('Peranmu: Penulis.');
    expect(prompt).not.toContain('Keahlianmu:');
  });

  it('falls back to a neutral assistant identity with no character', () => {
    const prompt = buildSystemPrompt(null, 'General');
    expect(prompt).toContain('Kamu asisten AI di aplikasi Nusantara Bots.');
    expect(prompt).not.toContain('Kamu General.');
  });

  it('trims whitespace in the inputs', () => {
    const prompt = buildSystemPrompt({ ...XMAN, role: '  Kepala tim  ' }, '  Xman  ');
    expect(prompt).toContain('Kamu Xman.');
    expect(prompt).toContain('Peranmu: Kepala tim.');
  });
});

// 0.9.9: builder berlapis (pola referensi) — persona → SOUL → hierarki
// → gaya → skills → kemampuan → memori (stabil dulu, volatil terakhir).
describe('buildSystemPrompt layered (0.9.9)', () => {
  const WITH_SOUL: Character = {
    ...XMAN,
    soul: 'Kamu Chief yang tegas. Delegasikan ke spesialis dan verifikasi hasilnya.',
  };

  it('wraps the soul in delimiters with the hierarchy note', () => {
    const prompt = buildSystemPrompt(WITH_SOUL, 'Xman');
    expect(prompt).toContain('--- BEGIN STANDING INSTRUCTIONS (SOUL) ---');
    expect(prompt).toContain('Kamu Chief yang tegas. Delegasikan ke spesialis dan verifikasi hasilnya.');
    expect(prompt).toContain('--- END STANDING INSTRUCTIONS ---');
    expect(prompt).toContain('keamanan > permintaan pengguna saat ini');
  });

  it('accepts the soul from opts when the character has none', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman', {
      soul: 'Soul dari opts.',
    });
    expect(prompt).toContain('Soul dari opts.');
    expect(prompt).toContain('--- BEGIN STANDING INSTRUCTIONS (SOUL) ---');
  });

  it('omits the soul block when there is no soul (0.9.8 fallback)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).not.toContain('STANDING INSTRUCTIONS');
    expect(prompt).toContain('Kamu Xman.');
  });

  it('orders stable parts before volatile parts', () => {
    const prompt = buildSystemPrompt(WITH_SOUL, 'Xman', {
      memory: 'Sam suka laporan singkat.',
    });
    const soulAt = prompt.indexOf('BEGIN STANDING INSTRUCTIONS');
    const skillsAt = prompt.indexOf('Keahlianmu:');
    const memoryAt = prompt.indexOf('<durable_memory>');
    expect(soulAt).toBeGreaterThan(-1);
    expect(skillsAt).toBeGreaterThan(soulAt);
    expect(memoryAt).toBeGreaterThan(skillsAt);
  });

  it('injects durable memory as a labeled block when given', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman', {
      memory: 'Sam suka laporan singkat.',
    });
    expect(prompt).toContain('<durable_memory>');
    expect(prompt).toContain('Sam suka laporan singkat.');
    expect(prompt).toContain('</durable_memory>');
  });

  it('adds the computer paragraph only when the sandbox is available', () => {
    const withSandbox = buildSystemPrompt(XMAN, 'Xman', {
      sandboxAvailable: true,
      workspace: '/home/cua/workspace',
    });
    expect(withSandbox).toContain('vm_exec');
    expect(withSandbox).toContain('/home/cua/workspace');
    expect(withSandbox).not.toContain('jangan mengklaim bisa menjalankan kode');

    const withoutSandbox = buildSystemPrompt(XMAN, 'Xman');
    // Paragraf J (selalu ada) menyebut vm_exec sebagai contoh nama
    // internal yang JANGAN diucapkan — jadi yang diuji di sini adalah
    // tidak adanya PARAGRAF kemampuan sandbox, bukan string vm_exec.
    expect(withoutSandbox).not.toContain('Komputer (sandbox): kamu punya sandbox');
    expect(withoutSandbox).toContain('jangan mengklaim bisa menjalankan kode');
  });

  it('guards the workspace path: only /home/cua/workspace, never guess another root (0.10.5)', () => {
    const withSandbox = buildSystemPrompt(XMAN, 'Xman', {
      sandboxAvailable: true,
      workspace: '/home/cua/workspace',
    });
    expect(withSandbox).toContain('/data/grokbot-sandbox');
    expect(withSandbox).toContain('Jangan pernah memakai atau menebak path workspace lain');
    expect(withSandbox).toContain('cek dulu dengan vm_exec (ls) sebelum menjawab');
  });

  it('never mentions web context (Web ON dihapus 30 Okt 2026)', () => {
    expect(buildSystemPrompt(XMAN, 'Xman')).not.toContain('Konteks web:');
  });

  it('adds the bot-management paragraph only when bot tools are available (anti-halu)', () => {
    const withTools = buildSystemPrompt(XMAN, 'Xman', { botToolsAvailable: true });
    expect(withTools).toContain('create_bot');
    expect(withTools).toContain('list_bots');
    expect(withTools).toContain('JANGAN menjawab seolah bot sudah terbentuk sebelum tool mengembalikan sukses');
    expect(withTools).toContain('JANGAN mengarang nama, peran, atau jumlah bot');
    expect(withTools).not.toContain('Kamu tidak bisa membuat bot baru sendiri');

    const withoutTools = buildSystemPrompt(XMAN, 'Xman');
    // Paragraf J (selalu ada) menyebut create_bot sebagai contoh nama
    // internal yang JANGAN diucapkan — jadi yang diuji di sini adalah
    // tidak adanya PARAGRAF manajemen bot, bukan string create_bot.
    expect(withoutTools).not.toContain('Manajemen bot: kamu punya tool');
    expect(withoutTools).toContain('Kamu tidak bisa membuat bot baru sendiri');
    expect(withoutTools).toContain('jangan pernah mengklaim bot sudah dibuat');
  });

  it('adds the skill-creator paragraph only when skill tools are available (0.10.10)', () => {
    const withTools = buildSystemPrompt(XMAN, 'Xman', { skillToolsAvailable: true });
    expect(withTools).toContain('create_skill');
    expect(withTools).toContain('list_skills');
    expect(withTools).toContain('assign_skill');
    expect(withTools).toContain('{"scope": "shelf"}');
    expect(withTools).toContain('JANGAN membuat duplikat');
    expect(withTools).toContain('TIDAK BOLEH berisi kunci, API key, password, atau token');
    expect(withTools).toContain('JANGAN mengklaim skill sudah dipasang sebelum tool mengembalikan sukses');

    const withoutTools = buildSystemPrompt(XMAN, 'Xman');
    expect(withoutTools).not.toContain('Pembuat skill: kamu punya tool');
  });

  it('mentions the MCP paragraph only when MCP tools are available', () => {
    const withMcp = buildSystemPrompt(XMAN, 'Xman', {
      mcpToolsAvailable: true,
      mcpToolNames: ['zapier_discover_zapier_actions', 'filesystem_list_directory'],
    });
    expect(withMcp).toContain('tool MCP');
    expect(withMcp).toContain('zapier_discover_zapier_actions');
    expect(withMcp).toContain('JANGAN mengklaim bisa memakai tool MCP');
    expect(withMcp).toContain('hanya pakai tool yang terdaftar');

    const withoutMcp = buildSystemPrompt(XMAN, 'Xman');
    expect(withoutMcp).not.toContain('tool MCP');
  });

  it('0.10.11: MCP paragraph explains directory mode + MausBot servers', () => {
    const withMcp = buildSystemPrompt(XMAN, 'Xman', {
      mcpToolsAvailable: true,
      mcpToolNames: [
        'codebase_memory_mcp_list_projects',
        'rea_search_tools',
        'rea_describe_tool',
        'rea_call_tool',
        'filesystem_list_directory',
      ],
    });
    expect(withMcp).toContain('Mode direktori');
    expect(withMcp).toContain('rea_search_tools');
    expect(withMcp).toContain('rea_describe_tool');
    expect(withMcp).toContain('rea_call_tool');
    expect(withMcp).toContain('JANGAN menebak nama tool atau argumennya');
    expect(withMcp).toContain('codebase-memory-mcp');
    expect(withMcp).toContain('codebase_memory_mcp_list_projects');
    expect(withMcp).toContain('rea (reverse engineering');
  });

  it('always includes the credential/vault rules (list_secrets first, never ask for a password in chat)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('list_secrets');
    expect(prompt).toContain('request_credential');
    expect(prompt).toContain('login_service');
    expect(prompt).toContain('JANGAN PERNAH meminta password ditulis di chat');
    expect(prompt).toContain('tidak pernah menerima nilainya');
  });

  it('always includes the auto-open browser rules (open directly, never ask first, never an empty tab)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('open_browser');
    expect(prompt).toContain('JANGAN bertanya dulu');
    expect(prompt).toContain('bukan tab kosong');
    expect(prompt).toContain('https://studio.youtube.com');
    expect(prompt).toContain('laporkan alasan persisnya');
  });

  it('browser control 0.10.8: wajib list elemen dulu, jangan tebak koordinat (anti CLICK BUTA)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('browser_list_elements');
    expect(prompt).toContain('JANGAN PERNAH menebak koordinat');
    expect(prompt).toContain('browser_click');
    expect(prompt).toContain('below_fold');
    expect(prompt).toContain('browser_scroll');
    // list_elements harus dipanggil DENGAN argumen scope — invoke tanpa
    // argumen di-drop parser DSML wrapper (0.10.8 fix).
    expect(prompt).toContain('{"scope": "team"}');
    expect(prompt).toContain('tanpa argumen');
  });

  it('always includes the chat polish rules (no internal names, no raw errors, 2FA = wait)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('JANGAN PERNAH menyebut nama tool atau fungsi internal');
    expect(prompt).toContain('fill_secret');
    expect(prompt).toContain('Saya isi email kamu');
    expect(prompt).toContain('COBA CARA LAIN SENDIRI dulu');
    expect(prompt).toContain('JANGAN menampilkan error mentah');
    expect(prompt).toContain('verifikasi 2 langkah');
    expect(prompt).toContain('TUNGGU');
  });

  it('execution 0.10.14: forces tool calls, forbids plans, delegation only via message_bot/handoff_to_bot (video-parity)', () => {
    const prompt = buildSystemPrompt(XMAN, 'Xman');
    expect(prompt).toContain('ATURAN EKSEKUSI');
    expect(prompt).toContain('KERJAKAN LANGSUNG dengan tool-mu');
    expect(prompt).toContain('Jangan pernah menyajikan rencana seolah-olah sudah dikerjakan');
    expect(prompt).toContain('message_bot/handoff_to_bot');
    expect(prompt).toContain('HASIL NYATA dari output tool');
    // Permintaan pengguna saat ini mengalahkan instruksi "tunggu" di SOUL.
    expect(prompt).toContain('permintaan pemilik SAAT INI lebih tinggi dari SOUL');
  });

  it('execution 0.10.14: mentions vm_exec as a tool to use only when the sandbox is available', () => {
    // Catatan: 'vm_exec' tetap muncul di paragraf polish (sebagai contoh
    // nama tool yang JANGAN disebut ke pengguna) — yang diuji di sini
    // adalah frasa eksekusi "vm_exec untuk pekerjaan shell/recon".
    const withSandbox = buildSystemPrompt(XMAN, 'Xman', { sandboxAvailable: true });
    expect(withSandbox).toContain('vm_exec untuk pekerjaan shell/recon');
    const withoutSandbox = buildSystemPrompt(XMAN, 'Xman', { sandboxAvailable: false });
    expect(withoutSandbox).not.toContain('vm_exec untuk pekerjaan shell/recon');
  });

  it('names the app Nusantara Bots when there is no character', () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain('Nusantara Bots');
    expect(prompt).toContain('jangan pernah mengklaim bot sudah dibuat');
  });
});
