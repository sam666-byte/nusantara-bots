<p align="center">
  <a href="https://saweria.co/Nusantaraeaters">
    <img src="assets/saweria-qr.png" alt="Dukung Nusantara Bots via Saweria — scan QR ini" width="280">
  </a>
</p>

<h1 align="center">Nusantara Bots</h1>

<p align="center"><b>Tim AI Kamu, Dalam Satu Aplikasi.</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/Android-3DDC84?style=flat-square&logo=android&logoColor=white" alt="Android">
  <img src="https://img.shields.io/badge/version-0.10.18-blue?style=flat-square" alt="Version 0.10.18">
  <img src="https://img.shields.io/badge/React%20Native-0.86-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React Native 0.86">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  Aplikasi AI agent gratis di HP Android. Buat tim bot AI kamu sendiri — ngobrol, kerjakan tugas, akses komputer, semua dari satu aplikasi.
</p>

---

## 💛 Dukung Kami

**Nusantara Bots gratis dan open source.** Kalau aplikasi ini membantumu, dukung pengembangannya seikhlasnya lewat Saweria — berapapun, tanpa minimum yang memberatkan (mulai Rp1.000).

<p align="center">
  <a href="https://saweria.co/Nusantaraeaters">
    <img src="assets/saweria-qr.png" alt="QR Saweria — Dukung Nusantara Bots" width="220">
  </a>
</p>

<p align="center">
  👉 <b><a href="https://saweria.co/Nusantaraeaters">saweria.co/Nusantaraeaters</a></b>
</p>

> "Dukung Nusantara Bots - aplikasi AI agent gratis di HP. Donasi seikhlasnya buat pengembangan aplikasi. Terima kasih!"

Donasi dipakai untuk pengembangan aplikasi. Terima kasih atas dukungannya! 🙏

---

## 📥 Download APK

**v0.10.18 — APK release (arm64) sudah ada di repo ini:**

👉 **[Download Nusantara-0.10.18-arm64.apk](https://github.com/sam666-byte/nusantara-bots/raw/main/Nusantara-0.10.18-arm64.apk)** (38 MB)

- **Bisa dipakai di HP Android apapun** yang prosesornya ARM64 — Pixel, Samsung, Xiaomi, Oppo, Vivo, dan kebanyakan HP Android keluaran 5 tahun terakhir. **Bukan cuma buat HP Sam** — siapa saja bisa install.
- File APK-nya juga ada di repo ini: Nusantara-0.10.18-arm64.apk.
- HP 32-bit (ARMv7) dan emulator x86_64 tidak bisa pakai APK ini — butuh build terpisah (lihat [Build APK dari source](#-build-apk-dari-source)).

Install APK ke HP, lalu ikuti [Cara pakai pertama kali](#-cara-pakai-pertama-kali) di bawah.

---


## ✨ Fitur

- **🤖 Bikin bot sendiri** — Buat banyak bot dengan karakter dan tugas masing-masing. Ngobrol dengan mereka dalam satu aplikasi.
- **👑 Perintah bot (Chief → sub-bot)** — Satu bot Chief memimpin tim: Chief menerima perintahmu, lalu meneruskannya ke sub-bot yang tepat. Perintah ke sub-bot ditulis `@id-bot` di awal tugas (lihat [Perintah bot](#-perintah-bot-chief--sub-bot)).
- **🔑 BYOK penuh (Bring Your Own Key)** — Aplikasi **tidak menyertakan model atau API key apapun**. Kamu memakai provider AI pilihanmu sendiri dengan API key-mu sendiri (lihat [BYOK](#-byok--bring-your-own-key)).
- **🖥️ Server pendamping (opsional)** — Server Python di PC kamu untuk fitur bot, rooms, memory, MCP, dan Team Computer. Aplikasi tetap bisa dipakai untuk chat model langsung (BYO) tanpa server.
- **🏃 Runner server-side (opsional)** — Perintah bot tetap jalan di server walau aplikasi ditutup (lihat [Runner](#-runner-server-side-opsional-self-hosted)).
- **🖥️ Team Computer** — Lihat dan kendalikan desktop PC dari HP lewat VNC di dalam aplikasi.
- **🧰 MCP (Model Context Protocol)** — Bot bisa memakai tools: baca/tulis file, browsing, dan puluhan tools lain.
- **💾 Chat tersimpan** — Riwayat chat bot tersimpan dan tidak hilang saat keluar-masuk aplikasi.
- **🛠️ Skill Creator** — Buat skill sendiri untuk bot kamu.
- **⏱️ Timer & routines** — Bot bisa diingatkan dan dijadwalkan.
- **🔐 Vault** — Kredensial layanan tersimpan di server (nama layanan saja, nilai tidak pernah tampil). Bot memakai kredensial ini untuk login otomatis.

## Skill Pack - 282 Skill Agen Siap Pakai

Repo ini menyertakan 282 skill agen di folder skill-pack-agency/ (koleksi agency-agents oleh msitarzewski, lisensi MIT) - persona spesialis siap pakai untuk bot kamu: riset, coding, desain, keuangan, keamanan, media sosial, dan puluhan bidang lain.

Aman: skill-skill ini sudah diperiksa - tidak mengandung API key, token, kredensial, atau data pribadi apapun. Isinya murni instruksi kerja (SKILL.md) + README + LICENSE. Kamu bisa baca semuanya langsung di folder skill-pack-agency/.

Cara pakai: bot mengambil skill dari folder ini sesuai tugasnya. Daftar lengkap ada di skill-pack-agency/README.md.

---

## 🔑 BYOK — Bring Your Own Key

**Nusantara Bots tidak menyertakan model, provider, atau API key apapun.** Tidak ada preset model bawaan. Kamu memakai provider AI pilihanmu sendiri (yang kompatibel dengan API OpenAI) dengan API key milikmu sendiri. Begini cara kerjanya:

1. **Daftar ke provider AI** pilihanmu (yang kompatibel dengan API OpenAI).
2. **Dapatkan API key** dari dashboard provider tersebut.
3. **Di aplikasi**, buka **Settings → Model API sendiri (BYO)**, isi tiga hal: **Base URL** provider (mis. `https://api.providerkamu.com/v1`), **nama model**, dan **API key** kamu. Simpan.
4. **Selesai.** Semua bot langsung memakai model dan key tersebut.

**Keamanan key kamu:**

- Key disimpan **hanya di HP kamu**, di SecureStore (penyimpanan terenkripsi perangkat).
- Key **tidak pernah** dikirim ke server aplikasi dan **tidak pernah** masuk ke chat, log, atau riwayat.
- Key **tidak pernah** ada di repo ini — repo ini 100% bersih dari API key, token, dan kredensial apapun.
- Kalau ganti HP atau hapus aplikasi, key ikut terhapus — kamu tinggal masukkan lagi.

> 💡 **Tanpa key sendiri, aplikasi tidak bisa ngobrol dengan model AI.** Itu disengaja: key adalah milikmu, bukan milik aplikasi.

## 🚀 Cara pakai pertama kali

### Yang dibutuhkan

- HP Android (atau emulator) + APK di atas
- API key dari provider AI pilihanmu (lihat [BYOK](#-byok--bring-your-own-key))
- (Opsional) Server pendamping di PC, untuk fitur bot, rooms, memory, MCP, dan Team Computer

### Langkah 1 — Install APK

Install APK ke HP Android, lalu buka aplikasinya.

### Langkah 2 — Isi model (BYOK)

1. Buka aplikasi → **Settings → Model API sendiri (BYO)**.
2. Isi **Base URL**, **nama model**, dan **API key** dari provider AI pilihanmu.
3. Tekan **Simpan BYO**. Selesai — bot sudah bisa ngobrol.

### Langkah 3 (opsional) — Sambungkan ke server di PC

Langkah ini **opsional**. Kamu hanya butuh server kalau mau fitur bot, rooms, memory, MCP, dan Team Computer. Kalau cuma mau chat model langsung (BYO), Langkah 1 + 2 saja sudah cukup.

1. Deploy server pendamping di PC — kodenya ada di folder [`server/`](server/README.md) di repo ini. Clone repo, masuk ke folder `server/`, lalu jalankan (lihat [server/README.md](server/README.md) untuk cara lengkap).
2. Di aplikasi → **Settings → Server**, isi **Server URL** (alamat PC kamu, mis. `http://YOUR_SERVER:8780`) dan **Access Token** (kalau server pakai token — lihat di bawah), lalu simpan.
3. Tekan **Tes koneksi** — harus muncul "Terhubung ke server."

### Langkah 4 — Buat bot pertama

1. Dari Home, ketuk **+** (tambah bot).
2. Isi nama dan tugas bot itu (mis. "Asisten Riset — cari dan rangkum berita teknologi").
3. Buka chat bot itu dan mulai ngobrol.

## 👑 Perintah bot (Chief → sub-bot)

Rantai komandonya: **kamu → Chief → sub-bot**. Satu bot berperan sebagai Chief (pemimpin tim). Kamu memerintah lewat Chief, dan Chief meneruskan tugas ke sub-bot yang tepat.

**Cara pakai (tanpa server tambahan, lewat aplikasi):**

1. Buka chat Chief.
2. Tulis tugas dengan `@id-bot` di awal, mis. `Tolong @riset cari berita AI terbaru hari ini`.
3. Sub-bot mengerjakan, hasilnya kembali ke kamu.

**Cara pakai lewat Runner (bot tetap jalan walau aplikasi ditutup):** lihat [Runner](#-runner-server-side-opsional-self-hosted) — perintahnya diawali `RUNNER:`, mis. `RUNNER: @riset cari berita AI terbaru hari ini`.

Tips:

- Satu tugas, satu sub-bot — jangan menumpuk banyak perintah dalam satu pesan.
- Kalau sub-bot tidak dikenal, kamu akan diberi tahu daftar sub-bot yang tersedia.
- Perintah dari room bot lain (bukan Chief) tidak dijalankan oleh Runner — selalu lewat Chief.

## 🖥️ Server pendamping

Server pendamping ada di folder [`server/`](server/README.md) di repo ini (Python, tanpa dependensi pihak ketiga). Fungsinya: menyimpan bot, rooms, chat, memory, dan menjadi jembatan ke MCP dan Team Computer.

### Menjalankan server

```bash
git clone https://github.com/sam666-byte/nusantara-bots.git
cd nusantara-bots/server

# Buat file token (satu baris, rahasia)
echo -n "token-rahasia-kamu" > /path/to/token
chmod 600 /path/to/token

# Jalankan server (port 8780) — dengan token, tanpa OPEN_LAN
# (OPEN_LAN=1 justru mematikan token; itu opt-in khusus LAN tanpa token)
GROKBOT_APP_HOST=0.0.0.0 GROKBOT_APP_TOKEN_FILE=/path/to/token python3 -u app/server.py
```

atau pakai env var:

```bash
GROKBOT_APP_HOST=0.0.0.0 GROKBOT_APP_TOKEN=<token-rahasia> python3 -u app/server.py
```

Lihat [server/README.md](server/README.md) untuk cara install lengkap.

### Access token server (kalau pakai server pendamping)

Kalau server di-deploy supaya bisa diakses dari HP (bind LAN), server **wajib pakai access token**. Ini pengaman supaya hanya HP kamu yang bisa memakai server itu.

Token tersimpan di luar repo (file `chmod 600` atau env var) dan tidak pernah di-print di log — buka file-nya langsung untuk melihat isinya.

**Di aplikasi** — buka pengaturan server, isi kolom access token dengan token dari server, lalu simpan. Aplikasi mengirim token itu lewat header `X-Grokbot-Token` di setiap request.

**Kalau muncul `401 - Simpan akses token dahulu`:** artinya token belum disimpan di aplikasi (atau salah). Masukkan token server yang benar di pengaturan server, simpan, lalu coba lagi.

> 💡 Token akses server ini **beda** dengan API key model (BYOK). Token server = izin memakai server pendamping kamu. API key model = izin memakai model AI. Kamu butuh keduanya kalau pakai server + chat model.

### Server jauh (remote) — bukan cuma lokal

Server URL di aplikasi tidak dibatasi ke localhost: server di
VPS / box cloud (mis. Instabox) yang mengekspos port 8780 bisa
dipakai langsung. Jalankan server di box dengan token (tanpa
`OPEN_LAN`), ekspos port 8780 lewat **HTTPS** — URL publik
Instabox untuk port 8780, reverse proxy HTTPS, atau Tailscale —
lalu isi URL HTTPS itu + access token di Pengaturan → Server.
Jangan pernah pakai `GROKBOT_APP_OPEN_LAN=1` atau `http://` telanjang
di internet publik. Panduan lengkap: [server/README.md](server/README.md)
bagian "Server jauh (remote)".

### Runner server-side (opsional, self-hosted)

Loop agen normalnya jalan di HP — begitu aplikasi di-background,
turn bisa mati. **Runner** adalah service Python kecil (stdlib saja)
yang menjalankan perintah bot di server pendamping, jadi bot tetap
jalan walau aplikasi ditutup.

Rantai komandonya: **kamu → Chief → sub-bot**. Hanya perintah yang
datang lewat room Chief yang dijalankan; perintah dari room bot
lain diabaikan. Untuk menyuruh sub-bot tertentu, tulis `@id-bot` di
awal tugas (mis. `RUNNER: @riset baca Analytics channel`).
Hasil lengkap diposting ke room sub-bot, salinannya ke room Chief.

Cara pakai singkat (tanpa install ulang APK):

1. Jalankan server pendamping, lalu jalankan Runner di PC yang sama:
   `python3 server/runner_service.py` (cek: `curl http://127.0.0.1:8791/health` harus `ok`).
2. Di aplikasi, buka chat Chief, kirim `RUNNER: <tugas kamu>`, lalu tutup aplikasi.
3. Buka lagi room itu nanti — balasannya sudah ada.

Panduan lengkap (perintah, delegasi, troubleshooting, batasan):
lihat [server/RUNNER-HOWTO.md](server/RUNNER-HOWTO.md). Desain dan
bukti test ada di [RUNNER-DIRECTIONS.md](RUNNER-DIRECTIONS.md) dan
[server/runner-mvp-test.md](server/runner-mvp-test.md).

### Team Computer (VNC + browser)

Untuk tab Computer/Browser di aplikasi, PC perlu menjalankan dua hal:

1. **noVNC** di port 6081 (untuk tab Browser/VNC):
   `python3 -m websockify --web <folder-noVNC> 0.0.0.0:6081 127.0.0.1:5900`
   (dengan x11vnc jalan di 5900).
2. **Chromium** di display yang sama dengan `--remote-debugging-port=9222`
   (untuk bot memakai browser lewat CDP).

Catatan: bot bisa klik/ketik di browser, tapi **tidak pernah tahu password Google kamu** — login akun (mis. YouTube Studio) tetap kamu yang ketik sendiri lewat browser VNC.

## 🚀 Build APK dari source

### Yang dibutuhkan

- Node.js 18+ dan npm
- JDK 17 dan Android SDK (untuk build APK)
- HP Android (atau emulator) untuk menjalankan aplikasi

```bash
# 1. Clone repo ini
git clone https://github.com/sam666-byte/nusantara-bots.git
cd nusantara-bots

# 2. Install dependencies
npm install

# 3. Build APK debug
cd android
./gradlew assembleDebug

# APK ada di: android/app/build/outputs/apk/debug/app-debug.apk
```

Untuk build release, buat keystore sendiri dan konfigurasikan signing di `android/app/build.gradle` (jangan pernah commit keystore ke repo).

### Tes

```bash
npm test        # jest
npx tsc --noEmit  # type check
```

## ❓ Troubleshooting

- **"Server tidak terjangkau" di aplikasi:** cek Server URL di Settings (IP + port PC benar?), pastikan server jalan dan HP satu jaringan dengan PC (WiFi yang sama, atau Tailscale). Tanpa server, aplikasi tetap bisa chat model langsung (BYO).
- **`401 - Simpan akses token dahulu`:** token server belum disimpan / salah. Isi access token di pengaturan server (lihat [Access token server](#access-token-server-kalau-pakai-server-pendamping)).
- **Bot tidak bisa ngobrol / "Model API request failed":** cek BYOK di Settings — Base URL, nama model, dan API key harus benar dan sesuai provider. Key yang salah = model menolak.
- **Bot berhenti saat aplikasi ditutup:** itu normal — loop agen jalan di HP. Pakai [Runner](#runner-server-side-opsional-self-hosted) supaya perintah tetap jalan di server.
- **Perintah Runner tidak jalan:** pastikan perintah dikirim di room Chief (bukan room sub-bot), diawali `RUNNER:`, dan Runner sedang jalan di PC (`curl http://127.0.0.1:8791/health` harus `ok`).
- **Team Computer hitam / browser belum berjalan:** pastikan noVNC (6081) dan Chromium CDP (9222) jalan di PC (lihat [Team Computer](#team-computer-vnc--browser)).

## 🏗️ Arsitektur

- **React Native 0.86 + React Navigation** — aplikasi Android (build manual via Gradle, bukan Expo).
- **`src/api/`** — client HTTP ke server pendamping + client model (OpenAI-compatible).
- **`src/api/providers.ts`** — provider BYOK (hanya Custom — base URL + model bebas, tanpa preset).
- **`src/api/byo.ts`** — penyimpanan config BYO (SecureStore) + stream chat model.
- **`src/api/client.ts`** — client server (bot, rooms, chat, memory, vault).
- **`src/components/` & `src/screens/`** — UI aplikasi.
- **`android/`** — kode native Android + Gradle (manual, bukan hasil generate Expo).
- **`server/`** — server pendamping (Python stdlib, tanpa dependensi). Lihat [server/README.md](server/README.md).

## 🤝 Kontribusi

Kontribusi dipersilakan! Silakan buka issue atau pull request. Pastikan `npm test` dan `npx tsc --noEmit` lolos sebelum mengirim PR.

## 📄 Lisensi

MIT License — lihat file [LICENSE](LICENSE) (Copyright 2026 Samir Jamal).

---

<p align="center">
  Dibuat dengan ❤️ untuk pengguna AI agent di Indonesia.<br>
  <a href="https://saweria.co/Nusantaraeaters">💛 Dukung via Saweria</a>
</p>
