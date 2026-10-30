// Layar chat satu bot / satu room. Top bar: panah back kiri, pil tengah
// (blob + nama), ••• kanan. Bubble abu gelap radius besar; nama bot warna
// aksen di atas pesan assistant; pesan user rata kanan. Composer: pil
// besar + tombol "+" bundar kiri + tombol suara putih bundar di dalam pil
// (berubah jadi kirim saat ada teks) + tombol STOP kotak saat bot membalas.
//
// Alur kirim: checkCapOrAllow dulu (fail-open, seperti deck web) → BYO
// ada = streamByoReply dengan AbortController, lalu persistMessage untuk
// user + balasan dan recordCost bila ada usage → BYO tidak ada =
// sendMockChat (server SUDAH menyimpan pesan user + balasan, jadi tidak
// ada persistMessage lagi di jalur ini) + efek typewriter. Stop
// membatalkan stream (AbortController) dan memanggil stopRoom.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  type AlertButton,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  checkCapOrAllow,
  getCharacters,
  getChat,
  getRooms,
  persistMessage,
  persistMessageWithRetry,
  recordCost,
  sendMockChat,
  stopRoom,
} from '../api/client';
import { getByo, streamByoReplyWithTools, wasByoEverConfigured, type ChatTool, type ParsedToolCall } from '../api/byo';
import {
  buildTaskExecutionRepairPrompt,
  looksLikePlanOnly,
  wantsTaskExecution,
} from '../api/taskExecution';
import {
  completeTurn,
  getTurn,
  isTurnRunning,
  registerTurn,
  requestCredentialViaRunner,
  setCredentialHandler,
  stopTurn,
  subscribeTurn,
  updateTurn,
} from '../api/turnRunner';
import {
  VM_EXEC_TOOL,
  VM_EXEC_TOOL_NAME,
  checkSandboxAvailable,
  executeVmExecTool,
} from '../api/sandbox';
import {
  CREATE_BOT_TOOL,
  CREATE_BOT_TOOL_NAME,
  LIST_BOTS_TOOL,
  LIST_BOTS_TOOL_NAME,
  executeBotTool,
} from '../api/botTools';
import {
  ASSIGN_SKILL_TOOL,
  ASSIGN_SKILL_TOOL_NAME,
  CREATE_SKILL_TOOL,
  CREATE_SKILL_TOOL_NAME,
  LIST_SKILLS_TOOL,
  LIST_SKILLS_TOOL_NAME,
  executeSkillTool,
} from '../api/skillTools';
import { executeMcpTool, getMcpTools } from '../api/mcpTools';
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
  executeBrowserClickTool,
  executeBrowserListElementsTool,
  executeBrowserScrollTool,
  executeBrowserTypeTool,
  executeBrowserZoomTool,
  executeOpenBrowserTool,
} from '../api/browserTools';
import { copyTextToClipboard } from '../api/clipboard';
import { splitMessageSegments } from '../api/messageTables';
import {
  REACTION_EMOJIS,
  getReactions,
  toggleReaction,
  type RoomReactions,
} from '../api/reactions';
import {
  CREDENTIAL_TOOLS,
  LIST_SECRETS_TOOL_NAME,
  LOGIN_SERVICE_TOOL_NAME,
  REQUEST_CREDENTIAL_TOOL_NAME,
  executeCredentialTool,
  type CredentialFormResult,
} from '../api/credentialTools';
import { saveSecret, validateSecretInput } from '../api/vault';
import { buildSystemPrompt } from '../api/systemPrompt';
import { roomIdFor } from '../api/botChat';
import {
  browsePage,
  buildPagePrompt,
  buildWebPrompt,
  extractUrls,
  searchWeb,
  splitLinkSegments,
} from '../api/web';
import { DELETE_BOT_OPTIONS, deleteBot, type DeleteBotMode } from '../api/deleteBot';
import { deleteRoomChat } from '../api/deleteRoom';
import { cycleAvatar } from '../api/avatar';
import { ghostColor } from '../api/blob';
import {
  THINKING_NO_PROGRESS_SECONDS,
  summarizeToolArgs,
  waitingSecondsSince,
  type ThinkingState,
} from '../api/thinking';
import type { ChatMessage, Character } from '../api/types';
import { GhostBlob } from '../components/GhostBlob';
import { TypingDots } from '../components/TypingDots';
import type { RootStackParamList } from '../navigation';
import { colors, radii, sizes, spacing, type } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ChatRoute = RouteProp<RootStackParamList, 'Chat'>;

type UiMessage = ChatMessage & { local?: boolean; streaming?: boolean };

let localId = -1;
function nextLocalId(): number {
  localId -= 1;
  return localId;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newTaskId(): string {
  return `chat-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Deteksi niat membuat bot (0.10.13, perbaikan create_bot).
 *
 * Dipakai untuk putaran perbaikan: bila pengguna meminta membuat
 * bot tapi model TIDAK memanggil create_bot sama sekali (malah
 * mengarang klaim sukses), putaran perbaikan memaksa model
 * memanggil tool-nya. Kata kunci Bahasa Indonesia + Inggris.
 */
function wantsCreateBot(text: string): boolean {
  const t = text.toLowerCase();
  // 0.10.13: kata kerja pembuatan + kata "bot"/"tim" di mana saja
  // dalam kalimat (bukan harus berdampingan — "Buatkan 2 bot baru"
  // punya angka di tengahnya, regex lama yang menuntut kata
  // berdampingan tidak menangkapnya sehingga putaran perbaikan
  // tidak jalan).
  const hasVerb = /\b(buat|buatkan|bikin|bentuk|tambah|tambahkan|create|make)\b/.test(t);
  const hasBot = /\b(bot|tim)\b/.test(t);
  return hasVerb && hasBot;
}

export function ChatScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<ChatRoute>();
  const { characterId, roomId: roomIdParam } = route.params;

  // Room chat 1-1: resolusi kanonik di api/botChat (dipakai juga
  // HomeScreen) — room mode "chat" yang anggotanya memuat id bot,
  // diutamakan yang anggotanya hanya bot itu; bila tidak ada, jatuh
  // ke room "general".
  const [roomId, setRoomId] = useState<string>(roomIdParam ?? 'general');
  const [character, setCharacter] = useState<Character | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomMembers, setRoomMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [replying, setReplying] = useState(false);
  const [capBlocked, setCapBlocked] = useState(false);
  // Menu ••• sheet (lihat openMenu): Modal sendiri, bukan Alert —
  // Alert Android mentok 3 tombol sehingga "Hapus bot" tak pernah tampil.
  const [menuVisible, setMenuVisible] = useState(false);
  // Peringatan server tidak terjangkau (0.10.12, perbaikan bug chat
  // hilang di HP): persist/getChat gagal DIAM-DIAM sebelum ini
  // (try/catch kosong, "offline-first") sehingga user tidak tahu
  // pesannya tidak tersimpan sampai chat hilang saat keluar-masuk.
  // Mulai 0.10.12 kegagalan itu DITAMPILKAN sebagai banner — user
  // harus tahu, bukan menebak. Null = server terjangkau / belum ada
  // kegagalan; dibersihkan otomatis saat persist/load berhasil lagi.
  const [serverWarning, setServerWarning] = useState<string | null>(null);
  // Toggle Web (0.9.7, permintaan Sam: bot bisa memakai kemampuan
  // browser) — per-chat, default OFF, hanya state lokal. Saat ON,
  // sebelum kirim ke model: pesan berisi URL -> browsePage (browser
  // asli PC, sesi login) untuk isi halaman; pesan biasa -> searchWeb
  // untuk hasil pencarian. Gagal = chat normal tanpa konteks web.
  const [webEnabled, setWebEnabled] = useState(false);
  const [searchingWeb, setSearchingWeb] = useState(false);
  // Indikator thinking di dalam chat (0.10.7, Sam: "tambah 1 thinking
  // jadi kita tau bot kerja apa bengon") — SATU indikator yang jadi
  // sumber kebenaran aktivitas. Muncul langsung saat kirim ("Berpikir"),
  // berubah tiap tool ("Memakai tool: <nama> — <ringkasan> (tool ke-N)"),
  // hilang saat teks balasan mengalir. Bila 30 dtk tanpa progres
  // (token/tool baru), teks jadi "Menunggu balasan model (N dtk tanpa
  // progres)". Menggantikan showTyping (pill TypingDots) + teks
  // toolActivity di webBar — keduanya dihapus supaya tidak dobel.
  // `thinkingProgressRef` = ms terakhir ada progres; timer di bawah
  // menghitung diam dari ref ini. `thinkingToolCountRef` = tool ke-N
  // dalam turn ini (naik tiap call, walau identik — progres terlihat).
  const [thinking, setThinking] = useState<ThinkingState | null>(null);
  const [thinkingWaitingSeconds, setThinkingWaitingSeconds] = useState(0);
  const thinkingProgressRef = useRef(0);
  const thinkingToolCountRef = useRef(0);

  // Detak indikator thinking (1 dtk): hitung sudah berapa lama tanpa
  // progres; >= 30 dtk -> mode "menunggu" (teks di footer berubah).
  useEffect(() => {
    if (!thinking) return;
    const timer = setInterval(() => {
      // 0.10.15: pakai waitingSecondsSince — bila ref masih 0
      // (thinking di-set tanpa noteThinkingProgress, mis. lewat
      // adoptRunningTurn), elapsed = 0, bukan timestamp Unix.
      const elapsed = waitingSecondsSince(thinkingProgressRef.current, Date.now());
      setThinkingWaitingSeconds(
        elapsed >= THINKING_NO_PROGRESS_SECONDS ? elapsed : 0,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [thinking]);

  const noteThinkingProgress = useCallback(() => {
    thinkingProgressRef.current = Date.now();
    setThinkingWaitingSeconds(0);
  }, []);

  const startThinking = useCallback(() => {
    thinkingToolCountRef.current = 0;
    thinkingProgressRef.current = Date.now();
    setThinkingWaitingSeconds(0);
    setThinking({ phase: 'thinking' });
  }, []);

  const showThinkingTool = useCallback(
    (call: ParsedToolCall, round?: number) => {
      thinkingToolCountRef.current += 1;
      noteThinkingProgress();
      setThinking({
        phase: 'tool',
        toolName: call.name,
        toolSummary: summarizeToolArgs(call),
        toolCount: thinkingToolCountRef.current,
        round,
      });
    },
    [noteThinkingProgress],
  );
  // ALWAYS ALLOW (0.10.7, Sam): semua tool diizinkan tanpa kartu
  // approval — tool tulis MCP JANGAN dijeda menunggu Izinkan/Tolak.
  // (Kartu approval M4 dihapus; executeMcpTool tetap menerima
  // approveWrite, tapi aplikasi selalu mengembalikan true.)
  // Form kredensial aman (0.10.0, bagian G): bila model memanggil
  // request_credential, tool loop DIJEDA dan kartu form tampil di
  // atas composer (username + password tertutup). Simpan = POST ke
  // vault server; Dismiss = tool mengembalikan "ditolak" dan model
  // tidak boleh memaksa. Nilai password TIDAK PERNAH masuk chat/log.
  const [pendingCredential, setPendingCredential] = useState<{
    service: string;
    label: string;
    url: string;
  } | null>(null);
  const credentialResolveRef = useRef<((result: CredentialFormResult) => void) | null>(null);
  const [credUsername, setCredUsername] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credError, setCredError] = useState('');
  const [credBusy, setCredBusy] = useState(false);
  // Salin + reaksi emoji (0.10.0, bagian I): long-press bubble →
  // menu Salin + emoji. Reaksi tersimpan lokal per room
  // (AsyncStorage); `copiedId` = pesan yang baru disalin (chip
  // "✓ Disalin" hilang sendiri setelah 1,5 detik).
  const [reactions, setReactions] = useState<RoomReactions>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Menu long-press lengkap (0.10.6, samakan dengan referensi Sam):
  // bottom sheet berisi baris reaksi emoji + Reply, Quote, Copy,
  // Select text, Speak message. `menuMessage` = pesan yang menunya
  // sedang terbuka; `selectTextMessage` = pesan yang teksnya sedang
  // ditampilkan selectable; `replyTarget` = pesan yang sedang
  // dibalas (bar konteks di atas composer, reply_to ikut tersimpan
  // di server saat kirim); `speakingId` = pesan yang sedang dibacakan.
  const [menuMessage, setMenuMessage] = useState<UiMessage | null>(null);
  const [selectTextMessage, setSelectTextMessage] = useState<UiMessage | null>(null);
  const [replyTarget, setReplyTarget] = useState<UiMessage | null>(null);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const inputRef = useRef<TextInput>(null);
  // Versi avatar (0.9.8): dinaikkan tiap kali avatar diganti lewat
  // menu •••, supaya GhostBlob header me-remount dengan look baru
  // (override tersimpan di AsyncStorage + cache api/blob).
  const [avatarVersion, setAvatarVersion] = useState(0);

  const listRef = useRef<FlatList<UiMessage>>(null);
  const abortRef = useRef<AbortController | null>(null);
  const replyingRef = useRef(false);
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cermin messages untuk send() (0.10.5, perbaikan "pikun"): callback
  // send tidak memasukkan `messages` di deps, jadi baca state langsung
  // di sana bisa basi — ref ini disinkronkan tiap render dan selalu
  // berisi turn-turn yang sudah ter-commit.
  const messagesRef = useRef<UiMessage[]>([]);

  const displayName = character?.name ?? roomName ?? route.params.title ?? 'Chat';
  const botId = characterId ?? null;
  const accent = ghostColor(botId);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  // 0.10.14 (Issue 3 — PALING PARAH): adopsi turn yang masih berjalan
  // di room ini. Dipanggil saat layar difokuskan — bila Sam keluar
  // saat bot mikir lalu kembali, instance layar yang baru tidak tahu
  // ada turn yang sedang berjalan (turn-nya sendiri TETAP jalan di JS,
  // tapi tidak terlihat). Fungsi ini menampilkan progres live
  // (thinking + streaming text dari turnRunner) sebagai bubble
  // streaming lokal, dan me-reload dari server saat turn selesai —
  // supaya Sam tidak mengira bot berhenti dan tidak perlu tanya ulang.
  // Mengembalikan fungsi unsubscribe (untuk cleanup saat blur).
  const adoptRunningTurn = useCallback(
    (room: string): (() => void) => {
      const snap = getTurn(room);
      if (!snap || snap.status !== 'running') return () => {};
      replyingRef.current = true;
      setReplying(true);
      setThinking(
        snap.thinking
          ? { phase: 'tool', toolName: snap.thinking }
          : { phase: 'thinking' },
      );
      // 0.10.15: inisialisasi ref progres — tanpa ini, timer hitung
      // elapsed dari ref 0 (= timestamp Unix raksasa).
      noteThinkingProgress();
      const liveId = nextLocalId();
      setMessages((prev) => [
        ...prev,
        {
          id: liveId,
          room,
          character: characterId ?? null,
          role: 'assistant',
          text: snap.text,
          created_at: nowIso(),
          local: true,
          streaming: true,
        },
      ]);
      const unsubscribe = subscribeTurn(room, (s) => {
        if (s.status === 'running') {
          setThinking(
            s.thinking
              ? { phase: 'tool', toolName: s.thinking }
              : { phase: 'thinking' },
          );
          // 0.10.15: tiap update progres dari turnRunner reset timer.
          noteThinkingProgress();
          setMessages((prev) =>
            prev.map((m) => (m.id === liveId ? { ...m, text: s.text } : m)),
          );
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== liveId));
          replyingRef.current = false;
          setReplying(false);
          setThinking(null);
          void getChat(room)
            .then((c) => {
              if (c) setMessages(c.messages ?? []);
            })
            .catch(() => {});
        }
      });
      return unsubscribe;
    },
    [characterId, noteThinkingProgress],
  );

  // 0.10.13: muat ulang dari server SETIAP kali layar ini difokuskan
  // (useFocusEffect), bukan hanya saat mount. Akar penyebab chat hilang
  // yang TERBUKTI di emulator 27 Okt 18:52: Sam keluar dari chat saat
  // bot masih bekerja, lalu masuk lagi — layar TIDAK remount (route
  // sama, characterId/roomIdParam tidak berubah) sehingga useEffect
  // mount tidak jalan lagi dan layar terus menampilkan pesan lokal
  // STALE (bahkan pesan lama yang sudah dihapus server), padahal
  // server sudah menyimpan pesan baru. Reload saat fokus memastikan
  // layar selalu menampilkan isi server yang sebenarnya.
  // Pengaman: bila bot sedang membalas (streaming lokal berjalan),
  // JANGAN timpa state — reload akan menghapus bubble streaming.
  useFocusEffect(
    useCallback(() => {
      if (replyingRef.current) return;
      let alive = true;
      let unsubscribeTurn: (() => void) | null = null;
      (async () => {
        const [chars, rooms] = await Promise.all([
          getCharacters().catch(() => null),
          getRooms().catch(() => null),
        ]);
        if (!alive) return;
        const charList = chars ?? [];
        if (characterId) {
          setCharacter(charList.find((c) => c.id === characterId) ?? null);
        }
        const roomList = rooms ?? [];
        let resolvedRoom = roomIdParam ?? 'general';
        if (!roomIdParam && characterId) {
          resolvedRoom = roomIdFor(characterId, roomList);
        }
        if (roomIdParam) {
          const room = roomList.find((r) => r.id === roomIdParam);
          if (room) {
            setRoomName(room.name);
            setRoomMembers(room.members ?? []);
          }
        }
        setRoomId(resolvedRoom);
        const chat = await getChat(resolvedRoom).catch(() => {
          // 0.10.12: gagal load = server tidak terjangkau — beri tahu
          // user lewat banner, jangan diam-diam tampilkan chat kosong
          // (itulah yang membuat Sam mengira chatnya hilang).
          if (alive) {
            setServerWarning(
              'Server tidak terjangkau — riwayat chat tidak bisa dimuat. Pesan baru tidak akan tersimpan sampai server terjangkau.',
            );
          }
          return null;
        });
        if (alive) {
          setMessages(chat?.messages ?? []);
          if (chat) setServerWarning(null);
          // 0.10.14 (Issue 3): bila ada turn yang masih berjalan di
          // room ini (Sam keluar saat bot mikir), adopsi — tampilkan
          // progres live-nya, reload dari server saat turn selesai.
          unsubscribeTurn = adoptRunningTurn(resolvedRoom);
        }
      })();
      return () => {
        alive = false;
        if (unsubscribeTurn) unsubscribeTurn();
      };
    }, [characterId, roomIdParam, adoptRunningTurn]),
  );

  useEffect(() => {
    scrollToEnd();
  }, [messages, scrollToEnd]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(
    () => () => {
      if (typewriterTimer.current) clearInterval(typewriterTimer.current);
    },
    [],
  );

  // Menu ••• (0.9.4, permintaan Sam): info bot + "Hapus bot" dengan
  // dua pilihan — hapus + memory, atau hapus saja (memory tetap).
  // Hapus hanya tersedia untuk chat 1-1 dengan satu bot; untuk room
  // tanpa bot, menu hanya menampilkan info.
  const runDeleteBot = useCallback(
    async (mode: DeleteBotMode) => {
      if (!botId) return;
      try {
        await deleteBot(botId, mode);
        navigation.goBack();
      } catch (e) {
        Alert.alert(
          'Gagal menghapus bot',
          e instanceof Error ? e.message : 'Server tidak merespons. Coba lagi.',
          [{ text: 'OK' }],
        );
      }
    },
    [botId, navigation],
  );

  const confirmDeleteBot = useCallback(() => {
    const buttons: AlertButton[] = DELETE_BOT_OPTIONS.map((opt) => ({
      text: opt.title,
      style: opt.mode === 'with-memory' ? 'destructive' : undefined,
      onPress: () => void runDeleteBot(opt.mode),
    }));
    buttons.push({ text: 'Batal', style: 'cancel' });
    Alert.alert(
      `Hapus ${displayName}?`,
      'Pilih "Hapus + memory" untuk menghapus bot beserta memory-nya, atau "Hapus saja" bila memory-nya mau tetap tersimpan.',
      buttons,
    );
  }, [displayName, runDeleteBot]);

  // Hapus chat (0.9.5, permintaan Sam): hapus ruangan ini beserta
  // semua pesannya. Hanya untuk ruangan biasa — chat "general"
  // (ruangan bersama, fallback semua chat 1-1) tidak bisa dihapus.
  // Seperti hapus bot: ruangan baru hilang dari daftar SETELAH
  // server mengonfirmasi; bila gagal, tampilkan error dan ruangan
  // tetap ada.
  const runDeleteChat = useCallback(async () => {
    try {
      await deleteRoomChat(roomId);
      navigation.goBack();
    } catch (e) {
      Alert.alert(
        'Gagal menghapus chat',
        e instanceof Error ? e.message : 'Server tidak merespons. Coba lagi.',
        [{ text: 'OK' }],
      );
    }
  }, [navigation, roomId]);

  const confirmDeleteChat = useCallback(() => {
    Alert.alert(
      `Hapus chat "${displayName}"?`,
      'Ruangan ini beserta semua pesannya akan dihapus permanen.',
      [
        { text: 'Hapus chat', style: 'destructive', onPress: () => void runDeleteChat() },
        { text: 'Batal', style: 'cancel' },
      ],
    );
  }, [displayName, runDeleteChat]);

  // Ganti avatar (0.9.8, permintaan Sam): majukan ke preset look
  // berikutnya (hue + variant yang jelas berbeda), simpan override
  // per bot, lalu tampilkan langsung di header + pesan + deck.
  const changeAvatar = useCallback(async () => {
    if (!botId) return;
    try {
      await cycleAvatar(botId);
      setAvatarVersion((v) => v + 1);
    } catch {
      Alert.alert('Gagal ganti avatar', 'Tidak bisa menyimpan avatar baru. Coba lagi.');
    }
  }, [botId]);

  // 0.10.17: menu ••• adalah Modal sheet sendiri, BUKAN Alert.alert.
  // Alert Android mentok 3 tombol (positive/negative/neutral) — menu
  // 6 tombol di atas terpotong jadi 3 pertama saja, sehingga "Hapus
  // bot" (tombol ke-4) TAK PERNAH tampil di Android. Itulah akar
  // keluhan "tidak bisa hapus bot" — bukan build basi.
  const openMenu = useCallback(() => {
    setMenuVisible(true);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuVisible(false);
  }, []);

  const showInfo = useCallback(() => {
    closeMenu();
    Alert.alert(
      displayName,
      character?.role || character?.summary || roomName || 'Ruang chat.',
      [{ text: 'OK' }],
    );
  }, [character, closeMenu, displayName, roomName]);

  const openComputer = useCallback(() => {
    closeMenu();
    // 0.9.6, permintaan Sam: Computer pindah ke DALAM chat bot.
    // 0.10.0: "Open computer" membuka Team Computer bot ini
    // (layar browser live + Take control), bukan daftar registry.
    navigation.navigate('TeamComputer', { characterId: botId ?? undefined, scope: 'team' });
  }, [botId, closeMenu, navigation]);

  // ALWAYS ALLOW (0.10.7, Sam): tool tulis MCP selalu diizinkan —
  // tidak ada kartu approval, tidak ada jeda menunggu pengguna.
  const allowAllTools = useCallback(async (): Promise<boolean> => true, []);

  // Form kredensial: tampilkan kartu form dan tunggu pengguna Simpan
  // / Dismiss. Dipanggil eksekutor request_credential.
  const requestCredential = useCallback(
    (input: { service: string; label: string; url: string }): Promise<CredentialFormResult> => {
      return new Promise<CredentialFormResult>((resolve) => {
        credentialResolveRef.current = resolve;
        setCredUsername('');
        setCredPassword('');
        setCredError('');
        setPendingCredential(input);
      });
    },
    [],
  );

  // 0.10.14 (Issue 3): daftarkan form kredensial layar ini sebagai
  // handler turnRunner SELAGI layar fokus. Turn yang jalan di
  // background (Sam keluar saat bot mikir) tetap bisa meminta
  // credential — bila layar ini fokus, form tampil; bila layar blur
  // (Sam di layar lain), handler dibersihkan dan request resolve
  // {saved:false} alih-alih menggantung selamanya.
  useFocusEffect(
    useCallback(() => {
      setCredentialHandler(requestCredential);
      return () => {
        setCredentialHandler(null);
      };
    }, [requestCredential]),
  );

  const submitCredential = useCallback(async () => {
    if (!pendingCredential || credBusy) return;
    const invalid = validateSecretInput({
      service: pendingCredential.service,
      username: credUsername,
      password: credPassword,
    });
    if (invalid) {
      setCredError(invalid);
      return;
    }
    setCredBusy(true);
    setCredError('');
    try {
      await saveSecret({
        service: pendingCredential.service,
        label: pendingCredential.label,
        username: credUsername,
        password: credPassword,
      });
      const resolve = credentialResolveRef.current;
      credentialResolveRef.current = null;
      setPendingCredential(null);
      setCredUsername('');
      setCredPassword('');
      if (resolve) resolve({ saved: true });
    } catch (e) {
      // Gagal simpan = form tetap terbuka dengan pesan server.
      setCredError(e instanceof Error ? e.message : 'Gagal menyimpan kredensial.');
    } finally {
      setCredBusy(false);
    }
  }, [pendingCredential, credBusy, credUsername, credPassword]);

  const dismissCredential = useCallback(() => {
    const resolve = credentialResolveRef.current;
    credentialResolveRef.current = null;
    setPendingCredential(null);
    setCredUsername('');
    setCredPassword('');
    setCredError('');
    if (resolve) resolve({ saved: false });
  }, []);

  // Reaksi dimuat tiap kali room berganti (pesan baru belum punya reaksi).
  useEffect(() => {
    let alive = true;
    getReactions(roomId).then((r) => {
      if (alive) setReactions(r);
    });
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Long-press pesan (0.10.6): bottom sheet lengkap — baris reaksi
  // emoji + Reply, Quote, Copy, Select text, Speak message. Mengganti
  // Alert.alert lama (0.10.0) yang di Android hanya menampilkan
  // sebagian tombol dalam dialog "Pesan" kosong.
  const onMessageLongPress = useCallback((item: UiMessage) => {
    void Speech.stop();
    setSpeakingId(null);
    setMenuMessage(item);
  }, []);

  const copyMessage = useCallback((item: UiMessage) => {
    void copyTextToClipboard(item.text).then((ok) => {
      if (!ok) return;
      setCopiedId(item.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  const reactToMessage = useCallback(
    (item: UiMessage, emoji: string) => {
      void toggleReaction(roomId, String(item.id), emoji).then(setReactions);
    },
    [roomId],
  );

  const replyToMessage = useCallback((item: UiMessage) => {
    setReplyTarget(item);
    setMenuMessage(null);
    inputRef.current?.focus();
  }, []);

  const quoteMessage = useCallback((item: UiMessage) => {
    const quote = item.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    setInput((prev) => (prev ? `${prev}\n${quote}\n` : `${quote}\n`));
    setMenuMessage(null);
    inputRef.current?.focus();
  }, []);

  const speakMessage = useCallback(
    (item: UiMessage) => {
      if (speakingId === item.id) {
        void Speech.stop();
        setSpeakingId(null);
        return;
      }
      // Bersihkan markup ringan supaya yang dibaca enak didengar.
      const clean = item.text.replace(/\*\*/g, '').replace(/`/g, '').trim();
      if (!clean) return;
      void Speech.stop();
      setSpeakingId(item.id);
      Speech.speak(clean, {
        language: 'id-ID',
        onDone: () => setSpeakingId(null),
        onStopped: () => setSpeakingId(null),
        onError: () => setSpeakingId(null),
      });
    },
    [speakingId],
  );

  useEffect(() => {
    return () => {
      void Speech.stop();
      const credResolve = credentialResolveRef.current;
      credentialResolveRef.current = null;
      if (credResolve) credResolve({ saved: false });
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const stopReply = useCallback(async () => {
    // 0.10.14: hentikan juga turn yang terdaftar di turnRunner — tombol
    // STOP di layar BARU harus bisa menghentikan turn yang dimulai
    // layar LAMA (controller-nya ada di runner, bukan di ref ini).
    stopTurn(roomId);
    abortRef.current?.abort();
    abortRef.current = null;
    // Stop juga menutup form kredensial (dianggap Dismiss).
    const credResolve = credentialResolveRef.current;
    credentialResolveRef.current = null;
    setPendingCredential(null);
    if (credResolve) credResolve({ saved: false });
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }
    replyingRef.current = false;
    setReplying(false);
    setThinking(null);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    try {
      await stopRoom(roomId);
    } catch {
      // Stop lokal tetap berlaku walau server tidak merespons.
    }
  }, [roomId]);

  const runTypewriter = useCallback(
    (fullText: string, streamId: number, serverAssistantId: number) => {
      let shown = 0;
      const step = Math.max(1, Math.ceil(fullText.length / 60));
      typewriterTimer.current = setInterval(() => {
        shown = Math.min(fullText.length, shown + step);
        const slice = fullText.slice(0, shown);
        setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, text: slice } : m)));
        if (shown >= fullText.length && typewriterTimer.current) {
          clearInterval(typewriterTimer.current);
          typewriterTimer.current = null;
          replyingRef.current = false;
          setReplying(false);
          // Ganti id lokal dengan id server (pesan sudah tersimpan).
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, id: serverAssistantId, streaming: false, local: false } : m)),
          );
        }
      }, 30);
    },
    [],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || replyingRef.current) return;
    // 0.10.14: jangan mulai turn baru bila turn room ini masih jalan
    // (dimulai layar lama, Sam kembali lalu mengetik lagi) — turn lama
    // yang menang; layar ini mengadopsinya via turnRunner, bukan
    // menumpuk turn kedua yang berebut persist.
    if (isTurnRunning(roomId)) return;
    setInput('');
    setCapBlocked(false);
    // Snapshot riwayat SEBELUM userMsg/streamMsg di-append (0.10.5,
    // perbaikan "pikun"): ref berubah saat render berikutnya (setelah
    // await di bawah), tapi snapshot ini tetap berisi turn-turn
    // sebelumnya saja — turn saat ini TIDAK duplikat di history.
    // Reply (0.10.6): snapshot target balasannya, lalu bersihkan bar
    // konteks — pesan terkirim dengan reply_to + konteks kutipan ke model.
    const reply = replyTarget;
    if (reply) setReplyTarget(null);
    const basePrompt = reply
      ? `(Membalas "${reply.text.slice(0, 200)}") ${text}`
      : text;
    const priorMessages = messagesRef.current;

    // 1. Cek batas pemakaian dulu (fail-open bila ledger tak terjangkau).
    const who = characterId ?? roomMembers[0] ?? roomId;
    try {
      const cap = await checkCapOrAllow(characterId ?? roomId);
      if (!cap.allowed) {
        setCapBlocked(true);
        setMessages((prev) => [
          ...prev,
          {
            id: nextLocalId(),
            room: roomId,
            character: characterId ?? null,
            role: 'assistant',
            text: cap.message || 'Batas pemakaian bot ini sudah tercapai. Coba lagi nanti.',
            created_at: nowIso(),
            local: true,
          },
        ]);
        return;
      }
    } catch {
      // checkCapOrAllow sudah fail-open; ini hanya pengaman.
    }

    const userMsg: UiMessage = {
      id: nextLocalId(),
      room: roomId,
      character: characterId ?? null,
      role: 'user',
      text,
      created_at: nowIso(),
      local: true,
    };
    const streamId = nextLocalId();
    const streamMsg: UiMessage = {
      id: streamId,
      room: roomId,
      character: characterId ?? null,
      role: 'assistant',
      text: '',
      created_at: nowIso(),
      local: true,
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, streamMsg]);
    replyingRef.current = true;
    setReplying(true);
    startThinking();
    const controller = new AbortController();
    abortRef.current = controller;
    // 0.10.14: daftarkan turn ke turnRunner supaya progresnya (streaming
    // text + tool yang jalan) terlihat dari layar mana pun — Sam keluar
    // saat bot mikir, kembali, dan melihat turn ini tetap berjalan.
    // Generasi dipakai supaya turn lama yang akhirnya selesai tidak
    // menimpa turn baru di room yang sama.
    const turn = registerTurn(roomId, controller);
    // 0.10.14: status akhir turn untuk turnRunner (subscriber me-reload
    // saat turn selesai, apa pun hasilnya).
    let turnStatus: 'done' | 'error' | 'stopped' = 'done';

    try {
      // 0.10.13: BYO FLAKY — SecureStore kadang gagal baca sesaat
      // (keystore sibuk / app baru bangun) sehingga getByo() null
      // dan app jatuh diam-diam ke MOCK (terbukti: Sam minta "list
      // full skil kamu" dijawab MOCK padahal turn sebelumnya model
      // asli jalan). Retry sekali sebelum menyerah; bila BYO pernah
      // dikonfigurasi tapi kini tidak terbaca, tampilkan error JELAS
      // (bukan MOCK) supaya Sam tahu BYO-nya bermasalah.
      let byo = await getByo().catch(() => null);
      if (!byo) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        byo = await getByo().catch(() => null);
      }
      if (!byo && (await wasByoEverConfigured().catch(() => false))) {
        // BYO pernah ada tapi kini hilang/rusak — JANGAN mock
        // diam-diam. Simpan pesan user, lalu tampilkan error jelas
        // sebagai balasan (dan simpan juga supaya tidak hilang).
        const errText =
          '⚠️ BYO tidak terbaca — konfigurasi model yang sebelumnya tersimpan kini tidak bisa dibaca dari HP ini. Pesanmu tersimpan, tapi aku tidak bisa menjawab dengan model. Coba tutup lalu buka lagi aplikasi; bila masih begini, isi ulang BYO (Settings → Model API sendiri) atau minta Muse mengecek.';
        try {
          const savedUser = await persistMessage(roomId, characterId ?? null, text, 'user');
          if (savedUser) {
            setMessages((prev) =>
              prev.map((m) => (m.id === userMsg.id ? { ...m, id: savedUser.message.id, local: false } : m)),
            );
          }
        } catch {
          setServerWarning(
            'Server tidak terjangkau — pesan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
          );
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, text: errText, streaming: false } : m)),
        );
        try {
          const savedErr = await persistMessageWithRetry(roomId, characterId ?? null, errText, 'assistant');
          if (savedErr) {
            setMessages((prev) =>
              prev.map((m) => (m.id === streamId ? { ...m, id: savedErr.message.id, local: false } : m)),
            );
          }
        } catch {
          // Balasan error gagal tersimpan — tetap tampil di layar.
        }
        setServerWarning(
          'BYO tidak terbaca — model asli tidak bisa dipakai. Coba tutup-buka aplikasi, atau import ulang BYO.',
        );
        return;
      }
      if (byo) {
        // 2a. BYO tersedia: bila toggle Web ON, ambil konteks web dulu
        // — URL di pesan dibuka lewat browser asli PC (sesi login),
        // pesan biasa dicari di web — lalu kirim prompt gabungan ke
        // model. Pesan user yang tampil/disimpan tetap teks asli.
        let modelPrompt = basePrompt;
        if (webEnabled) {
          setSearchingWeb(true);
          try {
            const urls = extractUrls(text);
            if (urls.length > 0) {
              const page = await browsePage(urls[0]);
              modelPrompt = buildPagePrompt(basePrompt, page);
            } else {
              const results = await searchWeb(text);
              modelPrompt = buildWebPrompt(basePrompt, results);
            }
          } catch {
            // Gagal ambil konteks web = chat normal tanpa konteks.
            modelPrompt = basePrompt;
          } finally {
            setSearchingWeb(false);
          }
        }
        // System prompt berlapis (0.9.9, pola referensi): persona +
        // SOUL + hierarki + gaya + skills + kemampuan. Konteks web
        // (bila Web ON) tetap digabung ke user message seperti
        // sebelumnya. Sandbox dicek sekali per kirim (fail-soft) dan
        // daftar tool MCP diambil paralel: bila sandbox tersedia,
        // model diberi tool vm_exec + paragraf komputer; bila tool
        // MCP tersedia, model diberi tool MCP + paragraf MCP. Bila
        // tidak ada, chat tetap jalan sebagai teks biasa.
        const [sandbox, mcpTools] = await Promise.all([
          checkSandboxAvailable().catch(() => ({ available: false, workspace: null })),
          getMcpTools(),
        ]);
        const sandboxAvailable = sandbox.available;
        const sandboxWorkspace = sandbox.workspace;
        const systemPrompt = buildSystemPrompt(character, displayName, {
          sandboxAvailable,
          workspace: sandboxWorkspace,
          webEnabled,
          botToolsAvailable: true,
          skillToolsAvailable: true,
          mcpToolsAvailable: mcpTools.length > 0,
          mcpToolNames: mcpTools.map((t) => t.function.name),
        });
        const onDelta = (full: string) => {
          // Token pertama mengalir -> indikator thinking hilang,
          // balasan asli yang tampil. Progres dicatat supaya timer
          // 30 dtk tidak salah menuduh.
          setThinking(null);
          noteThinkingProgress();
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, text: full } : m)));
          // 0.10.14: publikasikan teks streaming ke turnRunner supaya
          // layar lain (Sam keluar-masuk) melihat balasan mengalir.
          updateTurn(roomId, { text: full, thinking: '' }, turn.generation);
        };
        // 0.10.14: bungkus showThinkingTool — publikasikan nama tool
        // yang sedang jalan ke turnRunner (indikator "Memakai tool"
        // tetap terlihat di layar lain).
        const onToolCall = (call: ParsedToolCall, round?: number) => {
          showThinkingTool(call, round);
          updateTurn(roomId, { thinking: call.name }, turn.generation);
        };
        // Tool chat (0.10.0): tool bot SELALU tersedia (create_bot /
        // list_bots — anti-halu, hanya butuh server); tool kredensial
        // SELALU tersedia (list_secrets / request_credential /
        // login_service — vault, bagian G); open_browser SELALU
        // tersedia (buka browser langsung ke URL target, bagian H);
        // vm_exec hanya bila sandbox tersedia; tool MCP bila server
        // menyediakannya.
        // Router eksekutor gabungan (0.9.11 + M3 + G + H): nama tool
        // menentukan eksekutor — vm_exec, bot tools, kredensial,
        // open_browser, browser control, sisanya MCP. Tool tulis MCP
        // SELALU diizinkan (ALWAYS ALLOW 0.10.7 — tanpa kartu
        // approval); request_credential dijeda untuk form aman.
        const tools: ChatTool[] = [
          CREATE_BOT_TOOL,
          LIST_BOTS_TOOL,
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
        ];
        if (sandboxAvailable) tools.push(VM_EXEC_TOOL);
        tools.push(...mcpTools);
        const execTool = async (call: ParsedToolCall): Promise<string> => {
          if (call.name === VM_EXEC_TOOL_NAME) return executeVmExecTool(call);
          if (call.name === CREATE_BOT_TOOL_NAME || call.name === LIST_BOTS_TOOL_NAME) {
            return executeBotTool(call);
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
          if (
            call.name === LIST_SECRETS_TOOL_NAME ||
            call.name === REQUEST_CREDENTIAL_TOOL_NAME ||
            call.name === LOGIN_SERVICE_TOOL_NAME
          ) {
            // 0.10.14: lewat turnRunner — bila layar ini tidak fokus
            // (turn jalan di background), request resolve {saved:false}
            // alih-alih menggantung menunggu form yang tidak terlihat.
            return executeCredentialTool(call, requestCredentialViaRunner);
          }
          return executeMcpTool(call, allowAllTools);
        };
        // Batas waktu eksekusi tool (0.10.5): satu tool yang menggantung
        // — terbukti di emulator, MCP filesystem membaca direktori besar
        // sampai >4 menit tanpa jawaban sementara server baru timeout di
        // 600 dtk — tidak boleh membekukan chat. Setelah 180 dtk,
        // kembalikan teks timeout supaya model bisa menjawab dari yang
        // sudah diketahui, bukan menggantung tanpa kabar. Tool yang
        // asli tetap jalan di server sampai timeout-nya sendiri; yang
        // dibatasi di sini hanya penantian di aplikasi.
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
        // Simpan pesan user SEBELUM memanggil model (0.10.5): di versi
        // lama pesan user baru dipersist setelah balasan selesai —
        // bila balasan gagal / di-STOP di tengah jalan (terbukti di
        // emulator: turn "Di mana file analytics..." hilang dari
        // server), pertanyaan ikut hilang dari riwayat. Offline-first:
        // gagal simpan tidak menggagalkan chat — tapi mulai 0.10.12
        // kegagalan DITAMPILKAN sebagai banner (serverWarning) supaya
        // user tahu pesannya tidak tersimpan, bukan diam-diam hilang
        // saat keluar-masuk chat.
        try {
          const savedUser = await persistMessage(
            roomId,
            characterId ?? null,
            text,
            'user',
            reply ? String(reply.id) : undefined,
          );
          if (savedUser) {
            setMessages((prev) =>
              prev.map((m) => (m.id === userMsg.id ? { ...m, id: savedUser.message.id, local: false } : m)),
            );
            setServerWarning(null);
          }
        } catch {
          // Offline-first: pesan tetap tampil walau gagal tersimpan,
          // tapi user HARUS tahu (0.10.12).
          setServerWarning(
            'Server tidak terjangkau — pesan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
          );
        }
        let res = await streamByoReplyWithTools(byo, modelPrompt, {
          tools,
          execTool: execToolWithTimeout,
          systemPrompt,
          // Riwayat chat (0.10.5, perbaikan "pikun"): turn-turn
          // sebelumnya supaya model ingat konteks ("Iya legal" =
          // jawaban atas pertanyaan sebelumnya, bukan kata untuk
          // didefinisikan). Batas 20 pesan terakhir ditegakkan di
          // byo.ts (takeRecentHistory); pesan kosong / system
          // disaring di sana juga.
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
        // sama sekali (malah mengarang klaim sukses — terbukti di
        // emulator: "Konten Bot" + "Analisa Bot" diklaim dibuat
        // padahal server tidak punya), jalankan SATU putaran lagi
        // yang memaksa model memanggil create_bot. Teks karangan
        // putaran pertama dibuang, diganti hasil putaran perbaikan
        // (yang jujur — bot benar-benar dibuat atau gagal jujur).
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
        // sama sekali dan balasannya tampak seperti rencana (terbukti:
        // Web Bughunter Alpha menulis rencana recon pump.fun tanpa
        // menjalankan apa pun), jalankan SATU putaran lagi yang memaksa
        // model memanggil tool. Teks rencana putaran pertama dibuang,
        // diganti hasil putaran perbaikan (hasil nyata dari tool, atau
        // gagal jujur). Tidak jalan bila putaran create_bot di atas
        // sudah memanggil tool (res.toolCalls sudah berisi).
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
        const finalText = res.text;
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, text: finalText, streaming: false } : m)),
        );
        if (!controller.signal.aborted) {
          try {
            const savedAsst = await persistMessageWithRetry(roomId, characterId ?? null, finalText, 'assistant');
            if (savedAsst) {
              setMessages((prev) =>
                prev.map((m) => (m.id === streamId ? { ...m, id: savedAsst.message.id, local: false } : m)),
              );
              setServerWarning(null);
            }
          } catch {
            // Sama seperti di atas — user harus tahu (0.10.12).
            setServerWarning(
              'Server tidak terjangkau — balasan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
            );
          }
          if (res.usage) {
            try {
              await recordCost({
                bot: characterId ?? roomId,
                taskId: newTaskId(),
                taskKind: 'chat',
                model: byo.model,
                usage: res.usage,
              });
            } catch {
              // Gagal mencatat cost tidak menggagalkan chat.
            }
          }
        }
      } else {
        // 2b. Tanpa BYO: balasan mock. Server SUDAH menyimpan pesan user
        // + balasan (POST /api/chat), jadi tidak ada persistMessage lagi.
        // Jalur mock butuh character yang valid: untuk room tanpa satu
        // bot, pakai anggota pertama room sebagai penjawab.
        const res = await sendMockChat(roomId, who, text);
        setThinking(null);
        if (!res) {
          setMessages((prev) => prev.filter((m) => m.id !== streamId && m.id !== userMsg.id));
          throw new Error('Server menjawab 401 — simpan access token dulu.');
        }
        if (controller.signal.aborted) {
          setMessages((prev) => prev.filter((m) => m.id !== streamId));
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === userMsg.id ? { ...m, id: res.user_message.id, local: false } : m)),
          );
          runTypewriter(res.assistant_message.text, streamId, res.assistant_message.id);
          return;
        }
      }
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      // 0.10.14: catat status akhir untuk turnRunner.
      turnStatus = aborted ? 'stopped' : 'error';
      // 0.10.13: balasan PARSIAL yang sudah mengalir (via onDelta)
      // TETAP disimpan walau stream di-abort (STOP / keluar) atau
      // gagal (jaringan putus saat bot kerja). Sebelumnya balasan
      // hanya dipersist bila stream selesai utuh DAN tidak di-abort —
      // teks parsial hilang saat keluar-masuk chat. Ambil teks
      // parsial dari state lokal terakhir.
      const partial = messagesRef.current.find((m) => m.id === streamId)?.text?.trim() ?? '';
      if (partial) {
        try {
          const savedAsst = await persistMessageWithRetry(roomId, characterId ?? null, partial, 'assistant');
          if (savedAsst) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId ? { ...m, id: savedAsst.message.id, local: false, streaming: false } : m,
              ),
            );
            setServerWarning(null);
          } else {
            setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m)));
          }
        } catch {
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m)));
          setServerWarning(
            'Server tidak terjangkau — balasan parsial ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
          );
        }
      } else if (!aborted) {
        // 0.10.14: error tanpa teks parsial — SIMPAN ke server (retry),
        // bukan hanya tampil lokal. Sebelumnya pesan error ini hanya
        // di-set lewat setMessages; bila layar sudah unmount (Sam keluar
        // saat bot mikir), error itu hilang total dan Sam melihat chat
        // kosong tanpa penjelasan. Persist memastikan Sam melihat
        // alasannya saat kembali.
        const errText =
          e instanceof Error ? e.message : 'Gagal mendapat balasan. Periksa koneksi lalu coba lagi.';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId ? { ...m, text: m.text || errText, streaming: false } : m,
          ),
        );
        try {
          const savedErr = await persistMessageWithRetry(roomId, characterId ?? null, errText, 'assistant');
          if (savedErr) {
            setMessages((prev) =>
              prev.map((m) => (m.id === streamId ? { ...m, id: savedErr.message.id, local: false } : m)),
            );
            setServerWarning(null);
          }
        } catch {
          setServerWarning(
            'Server tidak terjangkau — balasan ini tidak tersimpan dan akan hilang saat keluar chat. Periksa WiFi / server.',
          );
        }
      } else {
        // Abort tanpa teks parsial — hapus bubble kosong.
        setMessages((prev) => prev.filter((m) => m.id !== streamId));
      }
    } finally {
      replyingRef.current = false;
      setReplying(false);
      setThinking(null);
      abortRef.current = null;
      // 0.10.14: tandai turn selesai di turnRunner — subscriber (layar
      // yang mengadopsi turn ini) me-reload dari server dan menampilkan
      // balasan final. Generasi memastikan turn lama tidak menimpa turn
      // baru. No-op bila tidak ada turn terdaftar.
      completeTurn(roomId, turnStatus, turn.generation);
    }
  }, [input, roomId, characterId, roomMembers, runTypewriter, webEnabled, allowAllTools, requestCredential, replyTarget, startThinking, showThinkingTool, noteThinkingProgress]);

  const renderItem = ({ item }: { item: UiMessage }) => {
    const isUser = item.role === 'user';
    const reaction = reactions[String(item.id)];
    return (
      <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowBot]}>
        {!isUser ? (
          <View style={styles.msgAvatar}>
            <GhostBlob botId={botId} size={sizes.blobMessage} state={item.streaming ? 'working' : 'idle'} />
          </View>
        ) : null}
        <Pressable
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}
          onLongPress={() => onMessageLongPress(item)}
          accessibilityLabel="Pesan — tekan lama untuk menu (balas, kutip, salin, pilih teks, bacakan, reaksi)"
        >
          {!isUser ? (
            <Text style={[styles.bubbleName, { color: accent }]}>{displayName}</Text>
          ) : null}
          {splitMessageSegments(item.text).map((seg, si) =>
            seg.type === 'table' ? (
              // Kotak analisa/tabel (0.10.0, bagian K): bisa di-slide
              // horizontal supaya kolom tidak terpotong di tepi bubble.
              // Monospace agar kolom tetap sejajar.
              <ScrollView
                key={si}
                horizontal
                showsHorizontalScrollIndicator
                nestedScrollEnabled
                style={styles.tableScroll}
              >
                <Text style={[styles.bubbleText, styles.tableText]}>{seg.text}</Text>
              </ScrollView>
            ) : (
              <Text key={si} style={styles.bubbleText}>
                {splitLinkSegments(seg.text).map((linkSeg, i) =>
                  linkSeg.url ? (
                    <Text
                      key={i}
                      style={styles.bubbleLink}
                      onPress={() => void Linking.openURL(linkSeg.text).catch(() => undefined)}
                    >
                      {linkSeg.text}
                    </Text>
                  ) : (
                    <Text key={i}>{linkSeg.text}</Text>
                  ),
                )}
              </Text>
            ),
          )}
          {reaction ? <Text style={styles.reactionChip}>{reaction}</Text> : null}
          {copiedId === item.id ? <Text style={styles.copiedChip}>✓ Disalin</Text> : null}
        </Pressable>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <View style={styles.topBar}>
        <Pressable style={styles.backButton} onPress={() => navigation.goBack()} accessibilityLabel="Kembali">
          <Text style={styles.backIcon}>←</Text>
        </Pressable>
        <View style={styles.pill}>
          <GhostBlob
            key={avatarVersion}
            botId={botId}
            size={sizes.blobPill}
            state={replying ? 'working' : 'idle'}
          />
          <Text style={styles.pillName} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <Pressable
          style={styles.menuButton}
          onPress={openMenu}
          accessibilityLabel="Menu"
        >
          <Text style={styles.menuIcon}>•••</Text>
        </Pressable>
      </View>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        <Pressable style={styles.menuScrim} onPress={closeMenu}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>{displayName}</Text>
            <Text style={styles.menuSubtitle}>Pilih aksi</Text>
            <Pressable style={styles.menuRow} onPress={showInfo}>
              <Text style={styles.menuRowText}>Lihat info</Text>
            </Pressable>
            <Pressable style={styles.menuRow} onPress={openComputer}>
              <Text style={styles.menuRowText}>Open computer</Text>
            </Pressable>
            {botId ? (
              <>
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    closeMenu();
                    void changeAvatar();
                  }}
                >
                  <Text style={styles.menuRowText}>Ganti avatar</Text>
                </Pressable>
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    closeMenu();
                    confirmDeleteBot();
                  }}
                >
                  <Text style={[styles.menuRowText, styles.menuDangerText]}>Hapus bot</Text>
                </Pressable>
              </>
            ) : null}
            {roomId !== 'general' ? (
              <Pressable
                style={styles.menuRow}
                onPress={() => {
                  closeMenu();
                  confirmDeleteChat();
                }}
              >
                <Text style={[styles.menuRowText, styles.menuDangerText]}>Hapus chat</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.menuRow, styles.menuCancelRow]} onPress={closeMenu}>
              <Text style={[styles.menuRowText, styles.menuCancelText]}>Batal</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {capBlocked ? (
        <View style={styles.capBanner}>
          <Text style={styles.capText}>Batas pemakaian tercapai — pesan tidak dikirim.</Text>
        </View>
      ) : null}

      {serverWarning ? (
        <View style={styles.serverBanner}>
          <Text style={styles.serverBannerText}>⚠️ {serverWarning}</Text>
          <Pressable onPress={() => setServerWarning(null)} accessibilityLabel="Tutup peringatan">
            <Text style={styles.serverBannerClose}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>Belum ada pesan. Sapa {displayName} dulu.</Text>
        }
        ListFooterComponent={
          thinking ? (
            <View style={styles.msgRow}>
              <View style={styles.msgAvatar}>
                <GhostBlob botId={botId} size={sizes.blobMessage} state="typing" />
              </View>
              <View style={[styles.bubble, styles.bubbleBot]}>
                {/* 30 Okt 2026, Sam: hapus tulisan abu-abu thinking
                    ("Memakai tool: …" / "Berpikir") total — yang
                    tersisa hanya TypingDots sebagai penanda bot
                    sedang bekerja, tanpa teks. */}
                <TypingDots />
              </View>
            </View>
          ) : null
        }
      />

      <View style={styles.webBar}>
        <Pressable
          style={[styles.webChip, webEnabled && styles.webChipOn]}
          onPress={() => setWebEnabled((v) => !v)}
          accessibilityLabel="Toggle pencarian web"
        >
          <Text style={[styles.webChipText, webEnabled && styles.webChipTextOn]}>
            🌐 Web {webEnabled ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
        {searchingWeb ? <Text style={styles.webSearching}>🌐 Mencari web…</Text> : null}
      </View>

      {/* ALWAYS ALLOW (0.10.7, Sam): tidak ada lagi kartu approval
          tool tulis — semua tool jalan langsung tanpa Izinkan/Tolak. */}

      {/* Form kredensial aman (0.10.0, bagian G): bot meminta login
          ke satu layanan dan vault masih kosong untuk layanan itu.
          Isi sekali, disimpan di vault server (terenkripsi) — bot
          hanya tahu "tersimpan", TIDAK PERNAH melihat nilainya.
          Dismiss = bot tidak boleh memaksa. */}
      {pendingCredential ? (
        <View style={styles.approvalCard}>
          <Text style={styles.approvalTitle}>{pendingCredential.label}</Text>
          {pendingCredential.url ? (
            <Text style={styles.approvalArgs}>{pendingCredential.url}</Text>
          ) : null}
          <Text style={styles.approvalText}>
            Simpan sekali di vault — bot bisa login ulang kapan pun tanpa kamu ketik lagi.
            Password tidak terlihat oleh bot.
          </Text>
          <Text style={styles.credLabel}>Username</Text>
          <TextInput
            style={styles.credInput}
            placeholder="Email / username"
            placeholderTextColor={colors.muted}
            value={credUsername}
            onChangeText={setCredUsername}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!credBusy}
          />
          <Text style={styles.credLabel}>Password</Text>
          <TextInput
            style={styles.credInput}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            value={credPassword}
            onChangeText={setCredPassword}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!credBusy}
          />
          {credError ? <Text style={styles.credError}>{credError}</Text> : null}
          <View style={styles.approvalRow}>
            <Pressable
              style={[styles.approvalBtn, styles.approvalAllow]}
              onPress={() => void submitCredential()}
              disabled={credBusy}
              accessibilityLabel="Simpan kredensial"
            >
              <Text style={styles.approvalAllowText}>{credBusy ? 'Menyimpan…' : 'Save'}</Text>
            </Pressable>
            <Pressable
              style={[styles.approvalBtn, styles.approvalDeny]}
              onPress={dismissCredential}
              disabled={credBusy}
              accessibilityLabel="Tutup form kredensial"
            >
              <Text style={styles.approvalDenyText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {replyTarget ? (
        <View style={styles.replyBar}>
          <Text style={styles.replyBarText} numberOfLines={1}>
            ↩ Membalas {replyTarget.role === 'user' ? 'Kamu' : displayName}:{' '}
            {replyTarget.text}
          </Text>
          <Pressable
            style={styles.replyBarClose}
            onPress={() => setReplyTarget(null)}
            accessibilityLabel="Batal membalas"
          >
            <Text style={styles.replyBarCloseText}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composer}>
        <Pressable
          style={styles.plusButton}
          onPress={() => Alert.alert('Lampiran', 'Lampiran belum tersedia di versi ini.')}
          accessibilityLabel="Lampiran"
        >
          <Text style={styles.plusIcon}>+</Text>
        </Pressable>
        <View style={styles.inputPill}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={`Message ${displayName}`}
            placeholderTextColor={colors.muted}
            value={input}
            onChangeText={setInput}
            multiline
            returnKeyType="send"
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <Pressable
            style={styles.voiceButton}
            onPress={() => {
              if (input.trim()) {
                void send();
              } else {
                Alert.alert('Suara', 'Rekaman suara belum tersedia di versi ini.');
              }
            }}
            accessibilityLabel={input.trim() ? 'Kirim' : 'Rekam suara'}
          >
            <Text style={styles.voiceIcon}>{input.trim() ? '➤' : '🎙️'}</Text>
          </Pressable>
        </View>
        {replying ? (
          <Pressable style={styles.stopButton} onPress={() => void stopReply()} accessibilityLabel="Stop">
            <Text style={styles.stopIcon}>■</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Menu long-press lengkap (0.10.6): bottom sheet — baris reaksi
          + Reply, Quote, Copy, Select text, Speak message. Overlay di
          belakang sheet menutup menu saat diketuk di luar. */}
      <Modal
        visible={menuMessage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuMessage(null)}
      >
        <View style={styles.menuWrap}>
          <Pressable
            style={styles.menuOverlay}
            onPress={() => setMenuMessage(null)}
            accessibilityLabel="Tutup menu pesan"
          />
          <View style={styles.menuSheet}>
            <View style={styles.menuEmojiRow}>
              {REACTION_EMOJIS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={[
                    styles.menuEmoji,
                    menuMessage && reactions[String(menuMessage.id)] === emoji
                      ? styles.menuEmojiActive
                      : null,
                  ]}
                  onPress={() => {
                    if (menuMessage) reactToMessage(menuMessage, emoji);
                    setMenuMessage(null);
                  }}
                  accessibilityLabel={`Reaksi ${emoji}`}
                >
                  <Text style={styles.menuEmojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.menuDivider} />
            {menuMessage ? (
              <>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => replyToMessage(menuMessage)}
                  accessibilityLabel="Reply"
                >
                  <Text style={styles.menuItemIcon}>↩</Text>
                  <Text style={styles.menuItemLabel}>Reply</Text>
                </Pressable>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => quoteMessage(menuMessage)}
                  accessibilityLabel="Quote"
                >
                  <Text style={styles.menuItemIcon}>💬</Text>
                  <Text style={styles.menuItemLabel}>Quote</Text>
                </Pressable>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => {
                    copyMessage(menuMessage);
                    setMenuMessage(null);
                  }}
                  accessibilityLabel="Copy"
                >
                  <Text style={styles.menuItemIcon}>📋</Text>
                  <Text style={styles.menuItemLabel}>Copy</Text>
                </Pressable>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => {
                    setSelectTextMessage(menuMessage);
                    setMenuMessage(null);
                  }}
                  accessibilityLabel="Select text"
                >
                  <Text style={styles.menuItemIcon}>Aa</Text>
                  <Text style={styles.menuItemLabel}>Select text</Text>
                </Pressable>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => {
                    speakMessage(menuMessage);
                    setMenuMessage(null);
                  }}
                  accessibilityLabel="Speak message"
                >
                  <Text style={styles.menuItemIcon}>🔊</Text>
                  <Text style={styles.menuItemLabel}>
                    {speakingId === menuMessage.id ? 'Stop bicara' : 'Speak message'}
                  </Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              style={styles.menuCancel}
              onPress={() => setMenuMessage(null)}
              accessibilityLabel="Batal"
            >
              <Text style={styles.menuCancelText}>Batal</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Select text (0.10.6): teks pesan ditampilkan selectable —
          tekan lama di dalam teks untuk seleksi bawaan Android. */}
      <Modal
        visible={selectTextMessage !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectTextMessage(null)}
      >
        <View style={styles.menuWrap}>
          <Pressable
            style={styles.menuOverlay}
            onPress={() => setSelectTextMessage(null)}
            accessibilityLabel="Tutup pilih teks"
          />
          <View style={styles.menuSheet}>
            <Text style={styles.selectTextTitle}>Pilih teks</Text>
            <ScrollView style={styles.selectTextScroll}>
              <Text selectable style={styles.selectTextBody}>
                {selectTextMessage?.text}
              </Text>
            </ScrollView>
            <Pressable
              style={styles.menuCancel}
              onPress={() => setSelectTextMessage(null)}
              accessibilityLabel="Tutup"
            >
              <Text style={styles.menuCancelText}>Tutup</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: spacing.xxl,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '300',
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    height: sizes.topPillHeight,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  pillName: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: '700',
    maxWidth: '75%',
  },
  menuButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIcon: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 1,
  },
  menuScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  menuCard: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: radii.card,
    padding: spacing.lg,
  },
  menuTitle: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: '700',
  },
  menuSubtitle: {
    color: colors.muted,
    fontSize: type.body,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  menuRow: {
    paddingVertical: spacing.md,
  },
  menuRowText: {
    color: colors.accent,
    fontSize: type.body,
    fontWeight: '600',
  },
  menuDangerText: {
    color: colors.danger,
  },
  menuCancelRow: {
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surface3,
  },
  capBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radii.card,
    padding: spacing.md,
  },
  capText: {
    color: colors.danger,
    fontSize: type.small,
  },
  // Banner server tidak terjangkau (0.10.12) — mirip capBanner, tapi
  // dengan tombol tutup (peringatan bisa di-dismiss; muncul lagi bila
  // persist/load gagal berikutnya).
  serverBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radii.card,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  serverBannerText: {
    flex: 1,
    color: colors.danger,
    fontSize: type.small,
  },
  serverBannerClose: {
    color: colors.muted,
    fontSize: type.small,
    fontWeight: '700',
    paddingHorizontal: spacing.xs,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  empty: {
    color: colors.muted,
    fontSize: type.preview,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  msgRowUser: {
    justifyContent: 'flex-end',
  },
  msgRowBot: {
    justifyContent: 'flex-start',
  },
  msgAvatar: {
    paddingTop: 2,
  },
  bubble: {
    borderRadius: radii.bubble,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    maxWidth: '82%',
  },
  bubbleBot: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 6,
  },
  bubbleUser: {
    backgroundColor: colors.surface2,
    borderTopRightRadius: 6,
  },
  bubbleName: {
    fontSize: type.preview,
    fontWeight: '700',
    marginBottom: 4,
  },
  bubbleText: {
    color: colors.text,
    fontSize: type.body,
    lineHeight: 24,
  },
  // Indikator thinking (0.10.7): teks fase di dalam bubble footer —
  // "Berpikir" / "Memakai tool: …" / "Menunggu balasan model (N dtk
  // tanpa progres)". Warna redup supaya jelas ini status, bukan balasan.
  thinkingText: {
    color: colors.muted,
    fontSize: type.body,
    lineHeight: 24,
  },
  // Kotak analisa/tabel (0.10.0, bagian K): wadah geser horizontal +
  // teks monospace agar kolom tabel tetap sejajar saat di-slide.
  tableScroll: {
    marginVertical: 4,
  },
  tableText: {
    fontFamily: 'monospace',
    fontSize: type.body - 1,
  },
  bubbleLink: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  reactionChip: {
    fontSize: 18,
    marginTop: 4,
  },
  copiedChip: {
    color: colors.accent,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: 4,
  },
  webBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  webChip: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  webChipOn: {
    backgroundColor: colors.accent,
  },
  webChipText: {
    color: colors.muted,
    fontSize: type.small,
    fontWeight: '700',
  },
  webChipTextOn: {
    color: colors.black,
  },
  webSearching: {
    color: colors.accent,
    fontSize: type.small,
  },
  approvalCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radii.card,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  approvalTitle: {
    color: colors.danger,
    fontSize: type.body,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  approvalText: {
    color: colors.text,
    fontSize: type.small,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  approvalArgs: {
    color: colors.muted,
    fontSize: type.small,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  approvalRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  approvalBtn: {
    flex: 1,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  approvalAllow: {
    backgroundColor: colors.accent,
  },
  approvalAllowText: {
    color: colors.black,
    fontSize: type.body,
    fontWeight: '700',
  },
  approvalDeny: {
    backgroundColor: colors.surface,
  },
  approvalDenyText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '700',
  },
  credLabel: {
    color: colors.text,
    fontSize: type.preview,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: spacing.sm,
  },
  credInput: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    color: colors.text,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  credError: {
    color: colors.danger,
    fontSize: type.small,
    marginBottom: spacing.sm,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  plusButton: {
    width: sizes.composerButton,
    height: sizes.composerButton,
    borderRadius: sizes.composerButton / 2,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusIcon: {
    color: colors.muted,
    fontSize: 30,
    fontWeight: '300',
    lineHeight: 34,
  },
  inputPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.input,
    minHeight: sizes.composerButton,
    paddingLeft: spacing.lg,
    paddingRight: 6,
    paddingVertical: 4,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
    maxHeight: 120,
  },
  voiceButton: {
    width: sizes.voiceButton,
    height: sizes.voiceButton,
    borderRadius: sizes.voiceButton / 2,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceIcon: {
    fontSize: 18,
    color: colors.black,
  },
  stopButton: {
    width: sizes.composerButton,
    height: sizes.composerButton,
    borderRadius: sizes.composerButton / 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopIcon: {
    color: colors.text,
    fontSize: 18,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface2,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: radii.input,
  },
  replyBarText: {
    flex: 1,
    color: colors.text,
    fontSize: type.small,
  },
  replyBarClose: {
    paddingHorizontal: spacing.sm,
  },
  replyBarCloseText: {
    color: colors.muted,
    fontSize: type.body,
  },
  menuWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  menuOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  menuEmojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: spacing.sm,
  },
  menuEmoji: {
    padding: spacing.sm,
    borderRadius: radii.input,
  },
  menuEmojiActive: {
    backgroundColor: colors.surface3,
  },
  menuEmojiText: {
    fontSize: 28,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.surface3,
    marginVertical: spacing.sm,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  menuItemIcon: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  menuItemLabel: {
    color: colors.text,
    fontSize: type.body,
  },
  menuCancel: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.surface3,
  },
  menuCancelText: {
    color: colors.muted,
    fontSize: type.body,
  },
  selectTextTitle: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  selectTextScroll: {
    maxHeight: 300,
  },
  selectTextBody: {
    color: colors.text,
    fontSize: type.body,
    lineHeight: 22,
  },
});
