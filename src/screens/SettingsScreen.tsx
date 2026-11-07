// Pengaturan — BYO (model API sendiri), alamat server, token akses,
// status koneksi, Vault, dan versi aplikasi.
//
// Keamanan: credential BYO dan token TIDAK pernah dikirim ke server
// aplikasi — credential hanya dipakai lewat streamByoReply ke model API.
// Setelah BYO disimpan, field credential dikosongkan dari layar.
//
// Vault (0.10.0, bagian G): daftar kredensial tersimpan di server
// (nama layanan saja — nilai TIDAK PERNAH tampil). Bot memakai
// kredensial ini untuk login otomatis via login_service; pengguna
// menyimpan lewat form aman di chat (request_credential) dan
// menghapus dari kartu ini.
//
// Model API sendiri (BYO): tidak ada preset model bawaan.
// Pengguna mengisi Base URL + model + credential provider-nya
// sendiri (OpenAI-compatible). Credential hanya dipakai lewat
// streamByoReply ke model API itu.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  checkHealth,
  getAuthToken,
  getServerUrl,
  isPlainHttpRemoteUrl,
  setAuthToken,
  setServerUrl,
} from '../api/client';
import { clearByo, getByo, saveByo } from '../api/byo';
import { deleteSecret, listSecrets, type StoredSecret } from '../api/vault';
import { ApiError } from '../api/types';
import { PROVIDERS, getProvider, inferProviderId } from '../api/providers';
import type { ByoConfig } from '../api/types';
import type { RootStackParamList } from '../navigation';
import { colors, radii, spacing, type } from '../theme';

export const APP_VERSION = '0.10.17';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const [providerId, setProviderId] = useState('custom');
  const [byoBaseUrl, setByoBaseUrl] = useState('');
  const [byoModel, setByoModel] = useState('');
  const [byoCredential, setByoCredential] = useState('');
  const [byoSaved, setByoSaved] = useState(false);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  // Credential tersimpan dipegang di memori (tidak pernah ditampilkan)
  // supaya menyimpan ulang base URL/model tanpa mengisi credential
  // tidak menghapus credential lama.
  const savedCredentialRef = useRef('');
  const [serverUrl, setServerUrlState] = useState('');
  const [token, setToken] = useState('');
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Vault (0.10.0): daftar layanan yang kredensialnya tersimpan.
  // `vaultState`: 'loading' | 'ready' | 'unsupported' (endpoint
  // belum ada di server) | 'error'. Nilai kredensial TIDAK PERNAH
  // dimuat ke layar ini — hanya nama layanan + tanggal simpan.
  const [secrets, setSecrets] = useState<StoredSecret[]>([]);
  const [vaultState, setVaultState] = useState<'loading' | 'ready' | 'unsupported' | 'error'>(
    'loading',
  );

  const provider = getProvider(providerId);
  const providerModels = provider.models;

  const loadVault = useCallback(async () => {
    setVaultState('loading');
    try {
      const list = await listSecrets();
      setSecrets(list ?? []);
      setVaultState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setVaultState('unsupported');
      } else {
        setVaultState('error');
      }
    }
  }, []);

  const load = useCallback(async () => {
    const byo = await getByo().catch(() => null);
    if (byo) {
      setByoBaseUrl(byo.baseUrl);
      setByoModel(byo.model);
      setProviderId(inferProviderId(byo.baseUrl));
      savedCredentialRef.current = byo.credential;
      setByoSaved(true);
    }
    const url = await getServerUrl().catch(() => '');
    setServerUrlState(url);
    const tok = await getAuthToken().catch(() => '');
    setToken(tok);
    const ok = await checkHealth().catch(() => false);
    setHealthy(ok);
    await loadVault();
  }, [loadVault]);

  useEffect(() => {
    load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Hapus kredensial satu layanan dari vault (nilai tidak pernah
  // tampil di layar — hanya nama layanan). Daftar lokal baru berubah
  // SETELAH server mengonfirmasi.
  const removeSecret = async (service: string) => {
    const ok = await deleteSecret(service);
    if (!ok) {
      Alert.alert('Vault', `Gagal menghapus ${service}.`, [{ text: 'OK' }]);
      return;
    }
    setSecrets((prev) => prev.filter((s) => s.service !== service));
  };

  // BYOK saja: satu-satunya provider adalah Custom (base URL +
  // model bebas, diisi manual). Tidak ada daftar preset lagi.
  const selectProvider = (id: string) => {
    setProviderId(getProvider(id).id);
  };

  const saveByoForm = async () => {
    if (!byoBaseUrl.trim() || !byoModel.trim()) {
      Alert.alert('BYO', 'Base URL dan model wajib diisi.');
      return;
    }
    const credential = byoCredential || savedCredentialRef.current;
    if (!credential) {
      Alert.alert('BYO', 'Credential wajib diisi.');
      return;
    }
    const cfg: ByoConfig = {
      baseUrl: byoBaseUrl.trim(),
      model: byoModel.trim(),
      credential,
    };
    setBusy(true);
    try {
      await saveByo(cfg);
      savedCredentialRef.current = credential;
      setByoSaved(true);
      setByoCredential(''); // Kosongkan credential dari field setelah disimpan.
      Alert.alert('BYO', 'Konfigurasi BYO disimpan.');
    } catch {
      Alert.alert('BYO', 'Gagal menyimpan konfigurasi BYO.');
    } finally {
      setBusy(false);
    }
  };

  const removeByo = async () => {
    setBusy(true);
    try {
      await clearByo();
      setProviderId('custom');
      setByoBaseUrl('');
      setByoModel('');
      setByoCredential('');
      savedCredentialRef.current = '';
      setByoSaved(false);
      Alert.alert('BYO', 'Konfigurasi BYO dihapus.');
    } catch {
      Alert.alert('BYO', 'Gagal menghapus konfigurasi BYO.');
    } finally {
      setBusy(false);
    }
  };

  const saveServer = async () => {
    setBusy(true);
    try {
      await setServerUrl(serverUrl.trim());
      Alert.alert('Server', 'Alamat server disimpan.');
    } catch (e) {
      Alert.alert(
        'Server',
        e instanceof Error ? e.message : 'Gagal menyimpan alamat server.',
      );
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setTestMsg('Menguji…');
    try {
      const ok = await checkHealth();
      setHealthy(ok);
      setTestMsg(ok ? 'Terhubung ke server.' : 'Server tidak terjangkau.');
    } catch {
      setHealthy(false);
      setTestMsg('Server tidak terjangkau.');
    }
  };

  const saveToken = async () => {
    setBusy(true);
    try {
      await setAuthToken(token);
      Alert.alert('Token', 'Access token disimpan.');
    } catch {
      Alert.alert('Token', 'Gagal menyimpan token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Pengaturan</Text>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, healthy ? styles.statusDotOk : styles.statusDotBad]} />
        <Text style={styles.statusText}>
          {healthy === null ? 'Status koneksi belum dicek.' : healthy ? 'Terhubung ke server' : 'Server tidak terjangkau'}
        </Text>
      </View>

      <Text style={styles.section}>Model API sendiri (BYO)</Text>
      <Text style={styles.hint}>
        {byoSaved
          ? 'BYO aktif. Credential tersimpan aman dan tidak ditampilkan lagi.'
          : 'Isi untuk memakai model API sendiri. Credential hanya dikirim ke model API, bukan ke server aplikasi.'}
      </Text>
      <Text style={styles.label}>Provider</Text>
      {PROVIDERS.map((p) => (
        <Pressable
          key={p.id}
          style={styles.optionRow}
          onPress={() => selectProvider(p.id)}
          disabled={busy}
        >
          <View style={[styles.optionDot, providerId === p.id && styles.optionDotSelected]} />
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionText}>{p.name}</Text>
            {p.id !== 'custom' ? (
              <Text style={styles.optionSub}>{p.baseUrl}</Text>
            ) : (
              <Text style={styles.optionSub}>Base URL dan model bebas</Text>
            )}
          </View>
        </Pressable>
      ))}
      <Text style={styles.label}>Base URL</Text>
      <TextInput
        style={styles.input}
        placeholder="https://api.contoh.com/v1"
        placeholderTextColor={colors.muted}
        value={byoBaseUrl}
        onChangeText={setByoBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.label}>Model</Text>
      {providerModels.length > 0 ? (
        <Pressable
          style={styles.modelField}
          onPress={() => setModelPickerVisible(true)}
          disabled={busy}
        >
          <Text style={styles.modelFieldText} numberOfLines={1}>
            {byoModel || 'Pilih model'}
          </Text>
          <Text style={styles.modelFieldChevron}>▾</Text>
        </Pressable>
      ) : (
        <TextInput
          style={styles.input}
          placeholder="nama-model"
          placeholderTextColor={colors.muted}
          value={byoModel}
          onChangeText={setByoModel}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      <Text style={styles.label}>Credential (API key)</Text>
      <TextInput
        style={styles.input}
        placeholder={byoSaved ? 'Tersimpan — isi untuk mengganti' : 'API key'}
        placeholderTextColor={colors.muted}
        value={byoCredential}
        onChangeText={setByoCredential}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.buttonPrimary]} onPress={saveByoForm} disabled={busy}>
          <Text style={styles.buttonPrimaryText}>Simpan BYO</Text>
        </Pressable>
        {byoSaved ? (
          <Pressable style={[styles.button, styles.buttonDanger]} onPress={removeByo} disabled={busy}>
            <Text style={styles.buttonDangerText}>Hapus BYO</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.section}>Server</Text>
      <Text style={styles.hint}>
        Bisa server lokal (http://192.168.x.x:8780) atau server jauh
        (https://alamat-box-kamu:8780, mis. URL publik Instabox untuk
        port 8780). Server jauh wajib pakai Access token di bawah.
      </Text>
      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        placeholder="https://alamat-server:8780"
        placeholderTextColor={colors.muted}
        value={serverUrl}
        onChangeText={setServerUrlState}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {isPlainHttpRemoteUrl(serverUrl) ? (
        <Text style={styles.hint}>
          ⚠️ Server jauh lewat http:// tanpa enkripsi — token dan isi
          chat bisa disadap di perjalanan. Pakai https:// bila bisa,
          dan jangan pernah memakai server tanpa token di internet publik.
        </Text>
      ) : null}
      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.buttonPrimary]} onPress={saveServer} disabled={busy}>
          <Text style={styles.buttonPrimaryText}>Simpan Server</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.buttonGhost]} onPress={testConnection}>
          <Text style={styles.buttonGhostText}>Tes koneksi</Text>
        </Pressable>
      </View>
      {testMsg ? <Text style={styles.testMsg}>{testMsg}</Text> : null}

      <Text style={styles.section}>Access token (opsional)</Text>
      <Text style={styles.label}>Token</Text>
      <TextInput
        style={styles.input}
        placeholder="Token akses server"
        placeholderTextColor={colors.muted}
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable style={[styles.button, styles.buttonPrimary]} onPress={saveToken} disabled={busy}>
        <Text style={styles.buttonPrimaryText}>Simpan Token</Text>
      </Pressable>

      {/* MCP (0.9.6): layar sendiri — daftar server + Connect MCP.
          Dulu bagiannya ada di sini (0.9.5), sekarang dipindah ke
          layar MCP supaya mudah ditemukan dari Home. */}
      <Text style={styles.section}>MCP</Text>
      <Pressable
        style={styles.optionRow}
        onPress={() => navigation.navigate('Mcp')}
        accessibilityLabel="MCP"
      >
        <View style={styles.optionTextWrap}>
          <Text style={styles.optionText}>Server MCP</Text>
          <Text style={styles.optionSub}>Lihat, nyalakan, dan hubungkan server MCP</Text>
        </View>
        <Text style={styles.linkChevron}>›</Text>
      </Pressable>

      {/* SPIKE 0.11.0 — HAPUS SEBELUM RILIS. Hanya tampil di build
          debug (__DEV__ true); di build rilis baris ini tidak ada. */}
      {__DEV__ ? (
        <Pressable
          style={styles.optionRow}
          onPress={() => navigation.navigate('OpenUiSpike')}
          accessibilityLabel="Tes UI spike"
        >
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionText}>Tes UI (spike)</Text>
            <Text style={styles.optionSub}>Layar tes sementara OpenUI — hapus sebelum rilis</Text>
          </View>
          <Text style={styles.linkChevron}>›</Text>
        </Pressable>
      ) : null}

      {/* Vault (0.10.0, bagian G): daftar kredensial tersimpan di
          server — nama layanan saja, nilai TIDAK PERNAH tampil.
          Simpan lewat form aman di chat; hapus dari sini. */}
      <Text style={styles.section}>Vault</Text>
      {vaultState === 'loading' ? (
        <Text style={styles.optionSub}>Memuat vault…</Text>
      ) : vaultState === 'unsupported' ? (
        <View style={styles.optionRow}>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionText}>Vault belum disiapkan</Text>
            <Text style={styles.optionSub}>
              Server belum menyediakan endpoint vault. Minta server di-update untuk mengaktifkan
              penyimpanan kredensial.
            </Text>
          </View>
        </View>
      ) : vaultState === 'error' ? (
        <>
          <Text style={styles.optionSub}>Vault tidak bisa dimuat.</Text>
          <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => void loadVault()}>
            <Text style={styles.buttonGhostText}>Muat ulang</Text>
          </Pressable>
        </>
      ) : secrets.length === 0 ? (
        <View style={styles.optionRow}>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionText}>Belum ada kredensial tersimpan</Text>
            <Text style={styles.optionSub}>
              Minta bot login ke suatu layanan — bot akan menampilkan form aman untuk isi sekali.
              Password tidak pernah terlihat oleh bot.
            </Text>
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.optionSub}>
            {secrets.length} kredensial tersimpan (nilai tidak ditampilkan).
          </Text>
          {secrets.map((s) => (
            <View key={s.service} style={styles.optionRow}>
              <View style={styles.optionTextWrap}>
                <Text style={styles.optionText}>{s.label || s.service}</Text>
                <Text style={styles.optionSub}>
                  {s.service} · disimpan {s.updated_at ? s.updated_at.slice(0, 10) : '—'}
                </Text>
              </View>
              <Pressable
                style={styles.vaultDeleteBtn}
                onPress={() => void removeSecret(s.service)}
                accessibilityLabel={`Hapus kredensial ${s.service}`}
              >
                <Text style={styles.vaultDeleteText}>Hapus</Text>
              </Pressable>
            </View>
          ))}
        </>
      )}

      <Text style={styles.version}>versi {APP_VERSION}</Text>

      <Modal
        visible={modelPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModelPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Pilih model — {provider.name}</Text>
            <FlatList
              data={providerModels}
              keyExtractor={(item) => item}
              style={styles.modalList}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.modalItem}
                  onPress={() => {
                    setByoModel(item);
                    setModelPickerVisible(false);
                  }}
                >
                  <Text
                    style={[
                      styles.modalItemText,
                      item === byoModel && styles.modalItemTextSelected,
                    ]}
                  >
                    {item}
                  </Text>
                  {item === byoModel ? <Text style={styles.modalItemCheck}>✓</Text> : null}
                </Pressable>
              )}
            />
            <Pressable
              style={[styles.button, styles.buttonGhost, styles.modalClose]}
              onPress={() => setModelPickerVisible(false)}
            >
              <Text style={styles.buttonGhostText}>Tutup</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxl,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusDotOk: {
    backgroundColor: colors.accent,
  },
  statusDotBad: {
    backgroundColor: colors.danger,
  },
  statusText: {
    color: colors.muted,
    fontSize: type.preview,
  },
  section: {
    color: colors.text,
    fontSize: type.name,
    fontWeight: '700',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.muted,
    fontSize: type.small,
    lineHeight: 18,
    marginBottom: spacing.sm,
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
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  vaultDeleteBtn: {
    backgroundColor: colors.surface2,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  vaultDeleteText: {
    color: colors.danger,
    fontSize: type.small,
    fontWeight: '700',
  },
  optionDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.muted,
  },
  optionDotSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  optionTextWrap: {
    flex: 1,
  },
  optionText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  optionSub: {
    color: colors.muted,
    fontSize: type.small,
    marginTop: 2,
  },
  linkChevron: {
    color: colors.accent,
    fontSize: 22,
    fontWeight: '700',
  },
  modelField: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  modelFieldText: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
  },
  modelFieldChevron: {
    color: colors.muted,
    fontSize: type.body,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    maxHeight: '80%',
  },
  modalTitle: {
    color: colors.text,
    fontSize: type.name,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  modalList: {
    flexGrow: 0,
  },
  modalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.surface2,
  },
  modalItemText: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
  },
  modalItemTextSelected: {
    color: colors.accent,
    fontWeight: '700',
  },
  modalItemCheck: {
    color: colors.accent,
    fontSize: type.body,
    fontWeight: '700',
  },
  modalClose: {
    marginTop: spacing.lg,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  button: {
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
    flex: 1,
  },
  buttonPrimaryText: {
    color: colors.black,
    fontSize: type.body,
    fontWeight: '700',
  },
  buttonDanger: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  buttonDangerText: {
    color: colors.danger,
    fontSize: type.body,
    fontWeight: '700',
  },
  buttonGhost: {
    backgroundColor: colors.surface2,
    flex: 1,
  },
  buttonGhostText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '700',
  },
  testMsg: {
    color: colors.muted,
    fontSize: type.small,
    marginTop: spacing.sm,
  },
  version: {
    color: colors.mutedDim,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
});
