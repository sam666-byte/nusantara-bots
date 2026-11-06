/**
 * Tests for the server API client (client.ts).
 *
 * AsyncStorage is an in-memory mock; fetch is a jest mock — no real
 * server is needed. The credential-invariance test asserts that no
 * POST body sent to /api/* ever carries a credential field.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CHAT_TIMEOUT_MS,
  DEFAULT_SERVER_URL,
  apiFetchResilient,
  checkCap,
  checkCapOrAllow,
  checkHealth,
  createCharacter,
  createRoom,
  deleteCharacter,
  getAuthToken,
  getCharacters,
  getChat,
  getHealth,
  getMemory,
  getRooms,
  getServerUrl,
  isLocalServerUrl,
  isPlainHttpRemoteUrl,
  persistMessage,
  persistMessageWithRetry,
  recordCost,
  saveMemory,
  sendMockChat,
  setAuthToken,
  setServerUrl,
  stopRoom,
} from '../client';
import { ApiError } from '../types';

jest.mock(
  '@react-native-async-storage/async-storage',
  () => {
    const store = new Map<string, string>();
    return {
      __store: store,
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    };
  },
  { virtual: true },
);

const fetchMock = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResponse(status: number, body: unknown): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  const store = (AsyncStorage as unknown as { __store: Map<string, string> }).__store;
  store.clear();
  jest.clearAllMocks();
});

describe('server URL + auth token settings', () => {
  it('defaults to the placeholder server URL (set your own in Settings)', async () => {
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe('http://YOUR_SERVER:8780');
  });

  it('stores a custom URL and strips the trailing slash', async () => {
    await setServerUrl('http://YOUR_SERVER:8780/');
    expect(await getServerUrl()).toBe('http://YOUR_SERVER:8780');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a server URL without an http(s) scheme', async () => {
    await expect(setServerUrl('example.com:8780')).rejects.toThrow(
      'http:// atau https://',
    );
    await expect(setServerUrl('ftp://example.com:8780')).rejects.toThrow(
      'http:// atau https://',
    );
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL);
  });

  it('accepts a remote (non-local) HTTPS server URL', async () => {
    await setServerUrl('https://box-kamu.example:8780/');
    expect(await getServerUrl()).toBe('https://box-kamu.example:8780');
  });

  it('classifies local vs plain-http remote server URLs', async () => {
    expect(isLocalServerUrl('http://127.0.0.1:8780')).toBe(true);
    expect(isLocalServerUrl('http://localhost:8780')).toBe(true);
    expect(isLocalServerUrl('https://box-kamu.example:8780')).toBe(false);
    // Plain http to a public host is remote and unencrypted.
    expect(isPlainHttpRemoteUrl('http://box-kamu.example:8780')).toBe(true);
    // https, loopback, and private-LAN http are not.
    expect(isPlainHttpRemoteUrl('https://box-kamu.example:8780')).toBe(false);
    expect(isPlainHttpRemoteUrl('http://127.0.0.1:8780')).toBe(false);
    expect(isPlainHttpRemoteUrl('http://192.168.1.10:8780')).toBe(false);
    expect(isPlainHttpRemoteUrl('http://10.0.0.5:8780')).toBe(false);
  });

  it('stores the auth token and clears it with an empty string', async () => {
    expect(await getAuthToken()).toBe('');
    await setAuthToken('  tok-1 ');
    expect(await getAuthToken()).toBe('tok-1');
    await setAuthToken('');
    expect(await getAuthToken()).toBe('');
  });
});

describe('auth header behaviour', () => {
  it('sends X-Grokbot-Token only when a token is stored', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { characters: [] }));
    await getCharacters();
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('X-Grokbot-Token');

    await setAuthToken('tok-1');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { characters: [] }));
    await getCharacters();
    expect(fetchMock.mock.calls[1][1].headers['X-Grokbot-Token']).toBe('tok-1');
  });

  it('returns null on 401 instead of an error body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'token required' }));
    expect(await getCharacters()).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'token required' }));
    expect(await getRooms()).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'token required' }));
    expect(await getChat('general')).toBeNull();
  });

  it('throws ApiError with the server message on 400', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'need a valid character and non-empty text' }),
    );
    let caught: unknown;
    try {
      await sendMockChat('general', 'nope', 'hi');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as Error).message).toContain('need a valid character');
  });
});

describe('checkHealth', () => {
  it('is true for any level (ok, warn, bad) — server answered', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { level: 'ok', reasons: [], checks: {}, uptime_seconds: 10, version: 'x' }),
    );
    expect(await checkHealth()).toBe(true);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { level: 'warn', reasons: ['x'], checks: {}, uptime_seconds: 10, version: 'x' }),
    );
    expect(await checkHealth()).toBe(true);
    // Level "bad" (mis. "no valid characters") = server hidup, bukan
    // tidak terjangkau — 0.10.6.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { level: 'bad', reasons: ['no valid characters'], checks: {}, uptime_seconds: 1, version: 'x' }),
    );
    expect(await checkHealth()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_SERVER_URL}/api/health`);
  });

  it('is false for HTTP errors and network errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'down' }));
    expect(await checkHealth()).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    expect(await checkHealth()).toBe(false);
  });

  it('is false when the 5s timeout fires (fetch aborts)', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const promise = checkHealth();
      await jest.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('endpoint shapes', () => {
  it('getCharacters unwraps {characters}', async () => {
    const chars = [{ id: 'chief', name: 'Chief', role: 'r', skills: [], memory_scope: 'team' }];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { characters: chars }));
    expect(await getCharacters()).toEqual(chars);
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_SERVER_URL}/api/characters`);
  });

  it('getRooms unwraps {rooms}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { rooms: [{ id: 'general', name: 'General', mode: 'chat', members: [] }], meeting_budget: 40, mock_label: 'MOCK' }),
    );
    expect(await getRooms()).toEqual([{ id: 'general', name: 'General', mode: 'chat', members: [] }]);
  });

  it('getChat passes the room query and unwraps messages', async () => {
    const messages = [{ id: 1, room: 'general', character: 'chief', role: 'user', text: 'hi', created_at: '2026-10-25T00:00:00Z' }];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { room: 'general', messages }));
    const data = await getChat('general');
    expect(data?.messages).toEqual(messages);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/chat?room=general');
  });

  it('sendMockChat posts {room, character, text, vision} and unwraps the reply', async () => {
    const body = {
      user_message: { id: 1, room: 'general', character: 'chief', role: 'user', text: 'hi', created_at: 'x' },
      assistant_message: { id: 2, room: 'general', character: 'chief', role: 'assistant', text: 'mock reply', created_at: 'x' },
      presence: [],
      model: 'MOCK',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
    const res = await sendMockChat('general', 'chief', 'hi');
    expect(res?.assistant_message.text).toBe('mock reply');
    expect(res?.model).toBe('MOCK');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ room: 'general', character: 'chief', text: 'hi', vision: false });
  });

  it('persistMessage posts role + text and unwraps {message}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { message: { id: 3, room: 'general', character: 'chief', role: 'assistant', text: 'done', created_at: 'x' } }),
    );
    const res = await persistMessage('general', 'chief', 'done', 'assistant');
    expect(res?.message.text).toBe('done');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ room: 'general', character: 'chief', text: 'done', role: 'assistant' });
  });

  it('createCharacter posts {name, focus} and unwraps {character}', async () => {
    const character = { id: 'scout', name: 'Scout', role: 'r', skills: [], memory_scope: 'team' };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { character }));
    expect(await createCharacter({ name: 'Scout', focus: 'research' })).toEqual(character);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ name: 'Scout', focus: 'research' });
  });

  it('createCharacter surfaces a 409 conflict', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "character 'scout' already exists" }));
    await expect(createCharacter({ name: 'Scout', focus: 'research' })).rejects.toMatchObject({
      status: 409,
    } as Partial<ApiError>);
  });

  it('createRoom posts {name, members, mode} (server field is mode, not kind)', async () => {
    const room = { id: 'rapat', name: 'Rapat', mode: 'meeting', members: ['chief'] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { room }));
    expect(await createRoom({ name: 'Rapat', members: ['chief'], mode: 'meeting' })).toEqual(room);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ name: 'Rapat', members: ['chief'], mode: 'meeting' });
  });

  it('createRoom posts mode "space" for a real space (0.10.0, bukan meeting)', async () => {
    const room = { id: 'cs', name: 'Customer support', mode: 'space', members: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { room }));
    expect(await createRoom({ name: 'Customer support', mode: 'space' })).toEqual(room);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ name: 'Customer support', members: [], mode: 'space' });
  });

  it('getMemory / saveMemory round-trip the memory shapes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { character: 'chief', scopes: ['team'], memories: [{ id: 1, scope: 'team', author: 'Chief', text: 'ingat', created_at: 'x', superseded_by: null }] }),
    );
    const mem = await getMemory('chief');
    expect(mem?.memories[0].text).toBe('ingat');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { character: 'chief', ids: { team: 2 }, scopes: ['team'] }));
    const saved = await saveMemory('chief', 'ingat ini');
    expect(saved?.ids).toEqual({ team: 2 });
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(sent).toEqual({ character: 'chief', text: 'ingat ini' });
  });

  it('stopRoom posts {room} and returns true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { stopped: true, message: {} }));
    expect(await stopRoom('general')).toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ room: 'general' });
  });

  it('getHealth returns the full report', async () => {
    const report = { level: 'ok', reasons: [], checks: {}, uptime_seconds: 5, version: 'v' };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, report));
    expect(await getHealth()).toEqual(report);
  });

  it('deleteCharacter sends DELETE /api/characters/:id with the with_memory flag (0.9.4)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: 'xman' }));
    expect(await deleteCharacter('xman', true)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://YOUR_SERVER:8780/api/characters/xman?with_memory=true');
    expect((init as RequestInit).method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: 'xman' }));
    expect(await deleteCharacter('xman', false)).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toContain('with_memory=false');
  });

  it('deleteCharacter returns false on 401 and throws ApiError on 501 (server belum dukung)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'token' }));
    expect(await deleteCharacter('xman', false)).toBe(false);
    fetchMock.mockResolvedValueOnce(jsonResponse(501, { error: 'not implemented' }));
    let caught: unknown;
    try {
      await deleteCharacter('xman', false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(501);
    expect((caught as Error).message).toContain('not implemented');
  });
});

describe('cost gate + ledger', () => {
  const gate = {
    bot: 'chief',
    day: '2026-10-25',
    cap_usd: 1,
    spent_usd: 0.5,
    remaining_usd: 0.5,
    allowed: true,
    message: 'sisa cap harian $0.5000 dari $1.0000',
  };

  it('checkCap returns the gate payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, gate));
    expect(await checkCap('chief')).toEqual(gate);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/costs/cap-check?bot=chief');
  });

  it('checkCapOrAllow fails open when the ledger is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    const res = await checkCapOrAllow('chief');
    expect(res.allowed).toBe(true);
    expect(res.cap_usd).toBeNull();
  });

  it('recordCost sends only numbers + model + ids, and skips when no usage', async () => {
    expect(await recordCost({ bot: 'chief', taskId: '1', model: 'm', usage: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse(201, { record: { bot: 'chief', cost_usd: 0.001 } }));
    const rec = await recordCost({
      bot: 'chief',
      taskId: '1',
      taskKind: 'chat',
      model: 'test-model',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(rec).toEqual({ bot: 'chief', cost_usd: 0.001 });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({
      bot: 'chief',
      task_id: '1',
      task_kind: 'chat',
      model: 'test-model',
      prompt_tokens: 10,
      completion_tokens: 5,
    });
  });

  it('recordCost never throws when the ledger fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(
      recordCost({ bot: 'chief', taskId: '1', model: 'm', usage: { prompt_tokens: 1 } }),
    ).resolves.toBeNull();
  });
});

describe('credential invariance — no /api/* body may carry a credential', () => {
  const FORBIDDEN_KEYS = new Set([
    'credential',
    'api_key',
    'apikey',
    'api-key',
    'secret',
    'token',
    'authorization',
    'password',
    'access_key',
  ]);

  it('no POST body in this module contains a credential field', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        user_message: {},
        assistant_message: {},
        presence: [],
        model: 'MOCK',
        message: {},
        character: {},
        room: {},
        ids: {},
        scopes: [],
        record: {},
        stopped: true,
      }),
    );
    await sendMockChat('general', 'chief', 'hi');
    await persistMessage('general', 'chief', 'done', 'assistant');
    await createCharacter({ name: 'Scout', focus: 'research' });
    await createRoom({ name: 'Rapat', mode: 'meeting' });
    await saveMemory('chief', 'ingat');
    await recordCost({ bot: 'chief', taskId: '1', model: 'm', usage: { prompt_tokens: 1 } });
    await stopRoom('general');

    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of fetchMock.mock.calls) {
      const body = call[1]?.body as string | undefined;
      if (!body) continue;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(FORBIDDEN_KEYS.has(key.toLowerCase())).toBe(false);
      }
      expect(body.toLowerCase()).not.toContain('sk-test');
    }
  });
});

describe('resilient chat fetch — timeout, single attempt (no alternate URL)', () => {
  it('primary succeeds → returns response, no retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const res = await apiFetchResilient('/api/health', CHAT_TIMEOUT_MS);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${DEFAULT_SERVER_URL}/api/health`);
  });

  it('primary network error → throws, single attempt', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(apiFetchResilient('/api/health', CHAT_TIMEOUT_MS)).rejects.toThrow(
      'Network request failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('primary HTTP error (400) is a real answer — no retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'unknown room' }));
    const res = await apiFetchResilient('/api/health', CHAT_TIMEOUT_MS);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('custom stored URL → single attempt to that URL', async () => {
    await setServerUrl('http://example.com:8780');
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(apiFetchResilient('/api/health', CHAT_TIMEOUT_MS)).rejects.toThrow(
      'Network request failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.com:8780/api/health');
  });

  it('timeout aborts a hanging fetch', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    await expect(apiFetchResilient('/api/health', 50)).rejects.toThrow('Aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getChat throws when the server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(getChat('xm')).rejects.toThrow('Network request failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persistMessage throws when the server is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(persistMessage('xm', 'xm', 'hi', 'user')).rejects.toThrow(
      'Network request failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persistMessageWithRetry (0.10.14) retries after a transient failure and returns the saved message', async () => {
    // Attempt 1: server fails → persistMessage throws.
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
    // Attempt 2: server succeeds.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { message: { id: 10, room: 'xm', role: 'assistant', text: 'done' } }),
    );
    const saved = await persistMessageWithRetry('xm', 'xm', 'done', 'assistant');
    expect(saved?.message.id).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persistMessageWithRetry (0.10.14) throws after all attempts fail', async () => {
    fetchMock.mockRejectedValue(new Error('Network request failed'));
    await expect(persistMessageWithRetry('xm', 'xm', 'done', 'assistant')).rejects.toThrow(
      'Network request failed',
    );
    // 3 attempts x 1 URL = 3 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
