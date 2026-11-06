// Layar Computer — gaya minimal satu layar penuh (pola delegasi, implementasi sendiri).
//
// Satu tampilan layar live (VNC WebView). Bila VNC gagal, otomatis jatuh ke
// screenshot Mirror sebagai cadangan — tanpa toggle mode di UI.
// Tidak ada toggle Team/Private (scope diambil dari parameter layar),
// tidak ada URL bar, tidak ada paragraf penjelasan panjang.
// Bar atas minimal: kembali, label komputer + status kontrol, dan satu
// tombol Take control / Lepas kontrol di tempat yang sama.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import {
  clickComputer,
  getComputerScreen,
  getComputerStatus,
  getNovncUrl,
  openComputerBrowser,
  releaseControl,
  takeControl,
  usingLabel,
  zoomComputer,
  type ComputerScope,
  type ComputerScreenShot,
  type ComputerStatus,
} from '../api/teamComputer';
import type { RootStackParamList } from '../navigation';
import { colors, radii, spacing, type } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type TeamComputerRoute = RouteProp<RootStackParamList, 'TeamComputer'>;

const POLL_MS = 2000;

/**
 * Cubit zoom WebView DIMATIKAN (perbaikan 31 Okt 2026): suntikan JS
 * lama yang membuka viewport noVNC sampai 5x membuat ketuk meleset
 * setelah zoom — WebView men-zoom halaman VNC-nya sendiri, bukan
 * halaman browser di PC, sehingga koordinat ketuk tidak lagi 1:1.
 * noVNC default (user-scalable=no) dibiarkan apa adanya supaya klik
 * selalu tepat; zoom halaman diganti tombol server (zoomComputer)
 * yang men-zoom isi browser, bukan halaman VNC.
 */

export function TeamComputerScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<TeamComputerRoute>();
  // Scope dari parameter saja (team = komputer tim, private = privat bot itu).
  // Tidak ada toggle di UI — layar ini menampilkan komputer yang dibuka.
  const scope: ComputerScope = route.params?.scope ?? 'team';
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [shot, setShot] = useState<ComputerScreenShot | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [novncUrl, setNovncUrl] = useState('');
  const [vncFailed, setVncFailed] = useState(false);
  const [vncKey, setVncKey] = useState(0);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const fetchingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const [s, shotData] = await Promise.all([
        getComputerStatus(scope),
        getComputerScreen(scope),
      ]);
      setStatus(s);
      setShot(shotData);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, [scope]);

  const doManualRefresh = useCallback(async () => {
    fetchingRef.current = false;
    await refresh();
  }, [refresh]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    void getNovncUrl()
      .then(setNovncUrl)
      .catch(() => setVncFailed(true));
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      // VNC sudah LIVE — poll status saja tiap 5 dtk supaya label
      // kontrol tetap segar. Di mode cadangan Mirror, poll layar+status 2 dtk.
      const timer = setInterval(
        () => {
          if (vncFailed) {
            void refresh();
          } else {
            void getComputerStatus(scope).then((s) => {
              if (s) setStatus(s);
            });
          }
        },
        vncFailed ? POLL_MS : 5000,
      );
      return () => clearInterval(timer);
    }, [refresh, vncFailed, scope]),
  );

  const userControls = status?.controlled_by === 'user';

  const doTakeControl = async () => {
    setActionBusy(true);
    setActionError('');
    const r = await takeControl(scope);
    if (!r.ok) setActionError(r.error ?? 'Gagal mengambil alih.');
    else await refresh();
    setActionBusy(false);
  };

  const doReleaseControl = async () => {
    setActionBusy(true);
    setActionError('');
    const r = await releaseControl(scope);
    if (!r.ok) setActionError(r.error ?? 'Gagal melepas kontrol.');
    else await refresh();
    setActionBusy(false);
  };

  const doResetVnc = async () => {
    // Remount WebView dari 100% (pulihkan bila tampilan pernah ter-zoom).
    setVncKey((k) => k + 1);
    await refresh();
  };

  const doZoomPage = async (direction: 'in' | 'out' | 'reset') => {
    setActionBusy(true);
    setActionError('');
    const r = await zoomComputer(scope, direction, 'user');
    if (!r.ok) setActionError(r.error ?? 'Zoom gagal.');
    setActionBusy(false);
  };

  const doOpenBrowser = async () => {
    setActionBusy(true);
    setActionError('');
    const r = await openComputerBrowser(scope, undefined, route.params?.characterId);
    if (!r.ok) setActionError(r.error ?? 'Gagal membuka browser.');
    else await refresh();
    setActionBusy(false);
  };

  const onTapScreen = async (e: GestureResponderEvent) => {
    if (!userControls || viewSize.width <= 0 || viewSize.height <= 0) return;
    const x = Math.min(1, Math.max(0, e.nativeEvent.locationX / viewSize.width));
    const y = Math.min(1, Math.max(0, e.nativeEvent.locationY / viewSize.height));
    const r = await clickComputer(scope, x, y);
    if (!r.ok) setActionError(r.error ?? 'Klik gagal.');
    else await refresh();
  };

  const shotUri = shot?.available && shot.image_b64 ? `data:image/png;base64,${shot.image_b64}` : null;
  const computerStopped = !status?.browser_open && !shotUri && !loading;

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <Pressable
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Kembali"
        >
          <Text style={styles.backIcon}>←</Text>
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>Computer</Text>
          <Text style={styles.statusText}>{usingLabel(status)}</Text>
        </View>
        {userControls ? (
          <Pressable
            style={[styles.controlButton, styles.controlButtonOn]}
            onPress={() => void doReleaseControl()}
            disabled={actionBusy}
            accessibilityLabel="Lepas kontrol"
          >
            <Text style={styles.controlButtonTextOn}>Lepas kontrol</Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.controlButton}
            onPress={() => void doTakeControl()}
            disabled={actionBusy}
            accessibilityLabel="Take control"
          >
            <Text style={styles.controlButtonText}>Take control</Text>
          </Pressable>
        )}
      </View>

      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

      {computerStopped ? (
        <View style={styles.emptyScreen}>
          <Text style={styles.emptyTitle}>Computer is stopped</Text>
          <Text style={styles.emptyText}>
            {shot?.reason ?? status?.screen_reason ?? 'Browser belum dibuka.'}
          </Text>
          <Pressable
            style={[styles.button, styles.buttonPrimary]}
            onPress={() => void doOpenBrowser()}
            disabled={actionBusy}
          >
            <Text style={styles.buttonPrimaryText}>Buka browser</Text>
          </Pressable>
        </View>
      ) : !vncFailed && novncUrl ? (
        <View style={styles.screenWrap}>
          <WebView
            key={vncKey}
            source={{ uri: novncUrl }}
            style={styles.screenView}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            onError={() => setVncFailed(true)}
            onHttpError={() => setVncFailed(true)}
            accessibilityLabel="Layar komputer — ambil kontrol untuk memakai langsung"
          />
          {!userControls ? (
            <Text style={styles.screenHint}>Bot sedang memakai — tekan Take control untuk mengambil alih.</Text>
          ) : (
            <Text style={styles.screenHint}>Kamu mengendalikan — ketuk langsung, cubit zoom dimatikan supaya klik tidak meleset.</Text>
          )}
          <View style={styles.controlsRow}>
            <Pressable
              style={[styles.button, styles.buttonGhost, styles.flexBtn]}
              onPress={() => void doResetVnc()}
              disabled={actionBusy}
              accessibilityLabel="Reset tampilan"
            >
              <Text style={styles.buttonGhostText}>⟲ Reset tampilan</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.buttonGhost, styles.flexBtn]}
              onPress={() => void doZoomPage('in')}
              disabled={actionBusy}
              accessibilityLabel="Zoom halaman masuk"
            >
              <Text style={styles.buttonGhostText}>Zoom +</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.buttonGhost, styles.flexBtn]}
              onPress={() => void doZoomPage('out')}
              disabled={actionBusy}
              accessibilityLabel="Zoom halaman keluar"
            >
              <Text style={styles.buttonGhostText}>Zoom −</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {loading ? (
            <Text style={styles.hint}>Memuat layar komputer…</Text>
          ) : shotUri ? (
            <Pressable
              style={styles.shotWrap}
              onPress={onTapScreen}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                setViewSize({ width, height });
              }}
              disabled={!userControls}
              accessibilityLabel={userControls ? 'Layar komputer — ketuk untuk klik' : 'Layar komputer'}
            >
              <Image
                source={{ uri: shotUri }}
                style={styles.screen}
                resizeMode="contain"
              />
              {!userControls ? (
                <Text style={styles.screenHint}>Bot sedang memakai — tekan Take control untuk mengambil alih.</Text>
              ) : (
                <Text style={styles.screenHint}>Kamu mengendalikan — ketuk layar untuk klik.</Text>
              )}
              {shot?.age_seconds !== null && shot?.age_seconds !== undefined ? (
                <Text style={shot.age_seconds > 10 ? styles.screenAgeStale : styles.screenAge}>
                  Layar diperbarui {Math.floor(shot.age_seconds)} dtk lalu
                  {shot.age_seconds > 10 ? ' — mungkin beku, tekan Refresh layar.' : ''}
                </Text>
              ) : null}
            </Pressable>
          ) : (
            <View style={styles.emptyScreen}>
              <Text style={styles.emptyTitle}>Layar belum tersedia</Text>
              <Text style={styles.emptyText}>
                {shot?.reason ?? status?.screen_reason ?? 'Browser belum dibuka atau screen capture belum jalan.'}
              </Text>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={() => void doOpenBrowser()}
                disabled={actionBusy}
              >
                <Text style={styles.buttonPrimaryText}>Buka browser</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.controlsRow}>
            <Pressable
              style={[styles.button, styles.buttonGhost, styles.flexBtn]}
              onPress={() => void doManualRefresh()}
              disabled={actionBusy}
              accessibilityLabel="Refresh layar"
            >
              <Text style={styles.buttonGhostText}>⟳ Refresh layar</Text>
            </Pressable>
            {!status?.browser_open && shotUri ? (
              <Pressable
                style={[styles.button, styles.buttonGhost, styles.flexBtn]}
                onPress={() => void doOpenBrowser()}
                disabled={actionBusy}
              >
                <Text style={styles.buttonGhostText}>Buka browser</Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
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
  titleWrap: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  statusText: {
    color: colors.muted,
    fontSize: type.small,
  },
  controlButton: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  controlButtonOn: {
    backgroundColor: colors.accent,
  },
  controlButtonText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  controlButtonTextOn: {
    color: colors.black,
    fontSize: type.body,
    fontWeight: '700',
  },
  screenWrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  screenView: {
    flex: 1,
    backgroundColor: '#000',
    borderRadius: radii.card,
    overflow: 'hidden',
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  hint: {
    color: colors.muted,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  shotWrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.sm,
  },
  screen: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: colors.black,
    borderRadius: radii.card,
  },
  screenHint: {
    color: colors.muted,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  screenAge: {
    color: colors.muted,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  screenAgeStale: {
    color: colors.danger,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  emptyScreen: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: type.name,
    fontWeight: '700',
  },
  emptyText: {
    color: colors.muted,
    fontSize: type.small,
    lineHeight: 18,
    textAlign: 'center',
  },
  error: {
    color: colors.danger,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  flexBtn: {
    flex: 1,
  },
  button: {
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
  },
  buttonPrimaryText: {
    color: colors.black,
    fontSize: type.body,
    fontWeight: '700',
  },
  buttonGhost: {
    backgroundColor: colors.surface,
  },
  buttonGhostText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
});
