/**
 * Tool file workspace tim untuk chat BYO (opsi 2, 1 Nov 2026).
 *
 * Resolver Bot butuh memeriksa folder/file workspace/sandbox tim, tapi
 * tool-nya hanya kontrol browser. Tool ini memberi model dua kemampuan
 * lewat server: list_files (isi direktori) dan read_file (isi file teks).
 *
 * Server mengunci root di /data/grokbot-own/workspace; path absolut,
 * "..", dan symlink keluar root ditolak server (400). Eksekutor ini
 * TIDAK PERNAH throw — semua kegagalan dikembalikan sebagai teks
 * supaya model melapor jujur ("tidak bisa membaca folder X"), bukan
 * mengarang isi folder atau file.
 */

import { apiJson } from './client';

import type { ChatTool, ParsedToolCall } from './byo';

export const LIST_FILES_TOOL_NAME = 'list_files';
export const READ_FILE_TOOL_NAME = 'read_file';

interface FileEntry {
  name: string;
  type: string;
  size: number;
}

interface ListFilesResponse {
  path?: string;
  entries?: FileEntry[];
  error?: string;
}

interface ReadFileResponse {
  path?: string;
  content?: string;
  error?: string;
}

export const LIST_FILES_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: LIST_FILES_TOOL_NAME,
    description:
      'List isi folder di workspace tim (server Nusantara) — pakai tool ini SETIAP KALI pengguna memintamu memeriksa, ' +
      'melihat, atau melaporkan isi folder, direktori, atau workspace/sandbox tim. ' +
      'Argumen path opsional (relatif terhadap root workspace; kosong = root). ' +
      'Hasil tool berisi daftar nama file/folder yang benar — laporkan daftar itu persis, jangan pernah mengarang nama file, ' +
      'dan bila tool gagal, katakan gagal dan alasannya, jangan mengarang isi folder.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path folder relatif terhadap root workspace (contoh: "" untuk root, "subfolder" untuk subfolder).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const READ_FILE_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: READ_FILE_TOOL_NAME,
    description:
      'Baca isi satu file teks di workspace tim (server Nusantara) — pakai tool ini SETIAP KALI pengguna memintamu ' +
      'membaca, memeriksa, atau mengutip isi file di workspace/sandbox tim. ' +
      'Argumen path wajib (relatif terhadap root workspace). ' +
      'Hasil tool berisi isi file yang benar — kutip dari situ, jangan pernah mengarang isi file, ' +
      'dan bila tool gagal, katakan gagal dan alasannya, jangan mengarang.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path file relatif terhadap root workspace (contoh: "contoh.txt").',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const MAX_CONTENT_CHARS = 8000;

async function executeListFiles(call: ParsedToolCall): Promise<string> {
  const raw = (call.args ?? {}) as Record<string, unknown>;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  let data: ListFilesResponse | null;
  try {
    data = await apiJson<ListFilesResponse>(
      '/api/files?path=' + encodeURIComponent(path),
    );
  } catch (e) {
    return (
      'Folder tidak bisa dilist (' +
      (e instanceof Error ? e.message : 'error tak dikenal') +
      '). Jangan mengklaim isi folder.'
    );
  }
  if (!data) {
    return 'Folder tidak bisa dilist: server tidak menjawab (mungkin butuh login ulang). Jangan mengklaim isi folder.';
  }
  if (typeof data.error === 'string' && data.error) {
    return 'Folder tidak bisa dilist: ' + data.error + '. Jangan mengklaim isi folder.';
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length === 0) {
    return 'Folder "' + (data.path ?? path) + '" kosong (tidak ada file/folder).';
  }
  const lines = entries.map((e) => {
    const kind = e.type === 'dir' ? 'dir' : 'file';
    return kind + ' ' + e.name + (e.type === 'dir' ? '/' : ' (' + e.size + ' byte)');
  });
  return 'Isi folder "' + (data.path ?? path) + '":\n' + lines.join('\n');
}

async function executeReadFile(call: ParsedToolCall): Promise<string> {
  const raw = (call.args ?? {}) as Record<string, unknown>;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) {
    return 'File tidak dibaca: path file wajib diisi. Jangan mengklaim isi file.';
  }
  let data: ReadFileResponse | null;
  try {
    data = await apiJson<ReadFileResponse>(
      '/api/files/content?path=' + encodeURIComponent(path),
    );
  } catch (e) {
    return (
      'File tidak bisa dibaca (' +
      (e instanceof Error ? e.message : 'error tak dikenal') +
      '). Jangan mengklaim isi file.'
    );
  }
  if (!data) {
    return 'File tidak bisa dibaca: server tidak menjawab (mungkin butuh login ulang). Jangan mengklaim isi file.';
  }
  if (typeof data.error === 'string' && data.error) {
    return 'File tidak bisa dibaca: ' + data.error + '. Jangan mengklaim isi file.';
  }
  const content = typeof data.content === 'string' ? data.content : '';
  if (content.length > MAX_CONTENT_CHARS) {
    return (
      'Isi file "' + (data.path ?? path) + '" (dipotong, hanya ' + MAX_CONTENT_CHARS + ' karakter pertama):\n' +
      content.slice(0, MAX_CONTENT_CHARS)
    );
  }
  return 'Isi file "' + (data.path ?? path) + '":\n' + content;
}

export async function executeFileTool(call: ParsedToolCall): Promise<string> {
  try {
    if (!call.argsValid) {
      return 'Tool file gagal: argumen tidak valid (bukan JSON objek). Jangan mengklaim isi folder atau file.';
    }
    if (call.name === LIST_FILES_TOOL_NAME) return executeListFiles(call);
    if (call.name === READ_FILE_TOOL_NAME) return executeReadFile(call);
    return 'Tool file tidak dikenal: ' + call.name + '.';
  } catch (e) {
    return (
      'Tool file gagal (' +
      (e instanceof Error ? e.message : 'error tak dikenal') +
      '). Jangan mengklaim isi folder atau file.'
    );
  }
}
