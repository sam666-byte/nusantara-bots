// Kartu modal "Create" — tampil sebagai modal transparan di atas Home.
// Menu: NEW BOT / NEW GROUP / NEW SPACE (teks toska). Memilih salah satu
// membuka form inline di kartu yang sama; setelah berhasil dibuat,
// layar ini diganti (replace) dengan Chat tujuan.
//
// Pemetaan ke API server:
// - NEW BOT → createCharacter({ name, focus, role }) — focus WAJIB salah
//   satu dari empat nilai server; dipilih lewat chip, bukan teks bebas.
// - NEW GROUP → createRoom({ name, members, mode: 'chat' }).
// - NEW SPACE → createRoom({ name, members, mode: 'space' }) — space
//   adalah workspace bernama (0.10.0, mode 'space' di server), bukan
//   meeting room. Anggota opsional: space boleh dibuat kosong lalu
//   diisi bot, atau langsung dengan bot di dalamnya.

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createCharacter, createRoom, focusCodeFor, getCharacters, getServerUrl } from '../api/client';
import { createBotChat } from '../api/botChat';
import type { CharacterFocus } from '../api/client';
import { ApiError } from '../api/types';
import type { Character } from '../api/types';
import type { RootStackParamList } from '../navigation';
import { colors, radii, spacing, type } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Mode = 'menu' | 'bot' | 'group' | 'space';

const FOCUS_OPTIONS: Array<{ value: CharacterFocus; label: string }> = [
  { value: 'day-to-day', label: 'Sehari-hari' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'research', label: 'Riset' },
  { value: 'everything', label: 'Serba bisa' },
];

/** Pesan error server apa adanya (bukan pesan generik) bila ada. */
function serverErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  // Kegagalan jaringan BUKAN error server, jadi diterjemahkan ke
  // pesan ramah (bukan mentah seperti "UnknownHostException").
  // Error server asli (nama duplikat, fokus tidak dikenal, dll.)
  // tetap ditampilkan apa adanya, sesuai aturan 0.10.9.
  if (/unknownhost|unable to resolve host|fetch failed|network request failed/i.test(raw)) {
    return 'Server tidak bisa dihubungi — cek Server URL di Settings dan pastikan server jalan dan satu jaringan.';
  }
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Gagal. Coba lagi.';
}

/** Pesan ramah bila Server URL masih placeholder, null bila sudah asli. */
async function placeholderServerError(): Promise<string | null> {
  try {
    const url = await getServerUrl();
    if (url.toLowerCase().includes('your_server')) {
      return 'Server URL masih placeholder — atur dulu di Settings → Server, isi alamat PC kamu, lalu coba lagi.';
    }
  } catch {
    // Gagal baca URL: biarkan panggilan server yang gagal dengan
    // pesan jaringan ramah di atas, jangan blokir di sini.
  }
  return null;
}

export function CreateSheet() {
  const navigation = useNavigation<Nav>();
  const [mode, setMode] = useState<Mode>('menu');
  const [name, setName] = useState('');
  const [focus, setFocus] = useState<CharacterFocus>('day-to-day');
  const [role, setRole] = useState('');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode === 'group' || mode === 'space') {
      getCharacters()
        .then((list) => setCharacters(list ?? []))
        .catch(() => setCharacters([]));
    }
  }, [mode]);

  const close = () => navigation.goBack();

  const submitBot = async () => {
    if (!name.trim()) {
      setError('Nama bot wajib diisi.');
      return;
    }
    const placeholder = await placeholderServerError();
    if (placeholder) {
      setError(placeholder);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bot = await createCharacter({
        name: name.trim(),
        focus: focusCodeFor(focus),
        role: role.trim() || undefined,
      });
      if (!bot) {
        setError('Server menjawab 401 — simpan access token dulu.');
        setBusy(false);
        return;
      }
      // 0.9.6: buatkan room 1-1 untuk bot baru supaya chat-nya mulai
      // kosong (bukan jatuh ke "general" yang masih menyimpan pesan
      // bot lama) dan langsung bisa dipakai tanpa keluar dulu.
      const target = await createBotChat(bot);
      navigation.replace('Chat', target);
    } catch (err) {
      // 0.10.9: tampilkan pesan error server apa adanya (mis. nama
      // duplikat "character 'xman' already exists" atau fokus tidak
      // dikenal) — jangan sembunyikan di balik "Gagal membuat bot".
      setError(serverErrorMessage(err));
      setBusy(false);
    }
  };

  const submitGroup = async () => {
    if (!name.trim()) {
      setError('Nama grup wajib diisi.');
      return;
    }
    const members = Object.keys(selected).filter((id) => selected[id]);
    if (members.length === 0) {
      setError('Pilih minimal satu anggota.');
      return;
    }
    const placeholder = await placeholderServerError();
    if (placeholder) {
      setError(placeholder);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const room = await createRoom({ name: name.trim(), members, mode: 'chat' });
      if (!room) {
        setError('Server menjawab 401 — simpan access token dulu.');
        setBusy(false);
        return;
      }
      navigation.replace('Chat', { roomId: room.id, title: room.name });
    } catch (err) {
      setError(serverErrorMessage(err));
      setBusy(false);
    }
  };

  const submitSpace = async () => {
    if (!name.trim()) {
      setError('Nama space wajib diisi.');
      return;
    }
    // Anggota opsional — space boleh dibuat kosong (workspace yang
    // nanti diisi bot) atau langsung dengan bot di dalamnya.
    const members = Object.keys(selected).filter((id) => selected[id]);
    const placeholder = await placeholderServerError();
    if (placeholder) {
      setError(placeholder);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const room = await createRoom({ name: name.trim(), members, mode: 'space' });
      if (!room) {
        setError('Server menjawab 401 — simpan access token dulu.');
        setBusy(false);
        return;
      }
      navigation.replace('Chat', { roomId: room.id, title: room.name });
    } catch (err) {
      setError(serverErrorMessage(err));
      setBusy(false);
    }
  };

  const toggleMember = (id: string) =>
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <Pressable style={styles.scrim} onPress={close}>
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {mode === 'menu' ? (
            <>
              <Text style={styles.title}>Create</Text>
              <View style={styles.menuRow}>
                <Pressable onPress={() => setMode('bot')}>
                  <Text style={styles.menuItem}>NEW BOT</Text>
                </Pressable>
                <Pressable onPress={() => setMode('group')}>
                  <Text style={styles.menuItem}>NEW GROUP</Text>
                </Pressable>
                <Pressable onPress={() => setMode('space')}>
                  <Text style={styles.menuItem}>NEW SPACE</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Pressable onPress={() => setMode('menu')}>
                <Text style={styles.back}>← Create</Text>
              </Pressable>
              <Text style={styles.title}>
                {mode === 'bot' ? 'New Bot' : mode === 'group' ? 'New Group' : 'New Space'}
              </Text>

              <Text style={styles.label}>Nama</Text>
              <TextInput
                style={styles.input}
                placeholder={mode === 'bot' ? 'Nama bot' : 'Nama'}
                placeholderTextColor={colors.muted}
                value={name}
                onChangeText={setName}
                autoFocus
              />

              {mode === 'bot' ? (
                <>
                  <Text style={styles.label}>Fokus / tugas utama</Text>
                  <View style={styles.chips}>
                    {FOCUS_OPTIONS.map((opt) => (
                      <Pressable
                        key={opt.value}
                        style={[styles.chip, focus === opt.value && styles.chipOn]}
                        onPress={() => setFocus(opt.value)}
                      >
                        <Text style={[styles.chipText, focus === opt.value && styles.chipTextOn]}>
                          {opt.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.label}>Peran (opsional)</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="cth. asisten pribadi"
                    placeholderTextColor={colors.muted}
                    value={role}
                    onChangeText={setRole}
                  />
                </>
              ) : null}

              {mode === 'group' || mode === 'space' ? (
                <>
                  <Text style={styles.label}>
                    {mode === 'space' ? 'Bot di space ini (opsional)' : 'Anggota'}
                  </Text>
                  {characters.length === 0 ? (
                    <Text style={styles.hint}>Belum ada bot untuk dipilih.</Text>
                  ) : (
                    characters.map((c) => (
                      <Pressable key={c.id} style={styles.memberRow} onPress={() => toggleMember(c.id)}>
                        <View style={[styles.checkbox, selected[c.id] && styles.checkboxOn]}>
                          {selected[c.id] ? <Text style={styles.checkMark}>✓</Text> : null}
                        </View>
                        <Text style={styles.memberName}>{c.name}</Text>
                      </Pressable>
                    ))
                  )}
                </>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable
                style={[styles.submit, busy && styles.submitBusy]}
                disabled={busy}
                onPress={mode === 'bot' ? submitBot : mode === 'group' ? submitGroup : submitSpace}
              >
                {busy ? (
                  <ActivityIndicator color={colors.black} />
                ) : (
                  <Text style={styles.submitText}>
                    {mode === 'bot' ? 'Buat Bot' : mode === 'group' ? 'Buat Grup' : 'Buat Space'}
                  </Text>
                )}
              </Pressable>
            </>
          )}
        </ScrollView>
      </Pressable>
      </KeyboardAvoidingView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  kav: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: radii.card,
    padding: spacing.xl,
    maxHeight: '80%',
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    marginBottom: spacing.xxl,
  },
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  menuItem: {
    color: colors.accentDim,
    fontSize: type.body,
    fontWeight: '600',
  },
  back: {
    color: colors.accentDim,
    fontSize: type.preview,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  label: {
    color: colors.text,
    fontSize: type.preview,
    fontWeight: '600',
    marginTop: spacing.md,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    color: colors.text,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.surface,
  },
  chipOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.text,
    fontSize: type.preview,
    fontWeight: '600',
  },
  chipTextOn: {
    color: colors.black,
  },
  hint: {
    color: colors.muted,
    fontSize: type.preview,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checkMark: {
    color: colors.black,
    fontWeight: '700',
  },
  memberName: {
    color: colors.text,
    fontSize: type.body,
  },
  error: {
    color: colors.danger,
    fontSize: type.small,
    marginTop: spacing.md,
  },
  submit: {
    marginTop: spacing.xl,
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  submitBusy: {
    opacity: 0.6,
  },
  submitText: {
    color: colors.black,
    fontSize: type.body,
    fontWeight: '700',
  },
});
