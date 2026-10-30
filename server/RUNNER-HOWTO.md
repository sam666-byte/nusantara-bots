# Runner Server-Side — HOWTO (Cara Pakai)

Bot Nusantara Bots tetap jalan walau kamu keluar dari aplikasi HP.
Runner adalah service kecil di PC yang menjalankan perintah bot di
server, lalu menyimpan balasannya di chat — jadi kamu kirim tugas,
tutup aplikasi, dan menemukan jawabannya sudah menunggu saat kembali.

**Tidak perlu install ulang APK.** Semua lewat chat yang sudah ada.

## Rantai komando

```
Kamu → Chief → sub-bot → kerja
```

- **Chief** adalah bot pertama yang memerintah. Hanya perintah yang
  datang lewat room Chief yang dijalankan Runner.
- **Sub-bot** (mis. bot analis, bot manager) tidak bisa diperintah
  langsung dari room-nya sendiri. Perintah untuk sub-bot harus lewat
  Chief (lihat "Delegasi" di bawah).
- Kalau ada bot yang jalan sendiri tanpa perintah Chief, itu salah —
  Runner akan mengabaikannya.

## Syarat

1. Server pendamping Nusantara Bots jalan (port 8780).
2. Runner jalan di PC yang sama (cek di bawah).
3. Endpoint model yang kompatibel OpenAI + API key-nya, diatur lewat
   environment (lihat "Konfigurasi"). Key **tidak pernah** ditulis
   di repo, log, atau chat.

## Mode otomatis (aktifkan sekali, disarankan)

Mulai Runner dengan mode otomatis, sekali saja saat start:

```bash
RUNNER_AUTO=1 setsid nohup python3 runner_service.py > /tmp/runner-mvp.log 2>&1 < /dev/null &
```

Atau pakai flag yang sama artinya:

```bash
python3 runner_service.py --auto
```

Setelah itu, **tidak perlu lagi menulis `RUNNER:` tiap task**.
Kirim tugas biasa saja di chat Chief, tutup aplikasi, balasannya
akan muncul di room. Delegasi tetap jalan tanpa prefix:

```
@yt-analytics Baca Analytics channel dan laporkan subscriber + 3 Shorts teratas.
```

Perintah lama `RUNNER: ...` tetap jalan di mode otomatis (prefix-nya
dipotong dulu). Yang tidak berubah: hanya room Chief yang
dijalankan, grace 90 detik, klaim tidak pernah diulang, dan cek
dobel sebelum posting. Untuk mematikan mode otomatis, restart
Runner tanpa `RUNNER_AUTO` (atau `RUNNER_AUTO=0`) — kembali ke
mode prefix.

## Cara pakai harian (mode prefix, kalau mode otomatis mati)

### 1. Pastikan Runner hidup

Dari PC (atau dari HP kalau satu jaringan dengan PC):

```bash
curl http://127.0.0.1:8791/health
```

Harus menjawab `"status": "ok"` plus `"chief_only": true` dan
`"delegation": true`. Kalau tidak menjawab, Runner belum jalan —
lihat "Menjalankan Runner".

### 2. Kirim perintah lewat chat Chief

Buka chat **Chief** di aplikasi, kirim:

```
RUNNER: Baca Analytics channel dan laporkan subscriber + 3 Shorts teratas.
```

Lalu **tutup aplikasi**. Bot bekerja di server. Buka lagi room
Chief nanti — balasannya sudah ada di sana.

### 3. Delegasi ke sub-bot

Untuk menyuruh sub-bot tertentu, tulis `@id-bot` di awal tugas:

```
RUNNER: @yt-analytics Baca Analytics channel dan laporkan subscriber + 3 Shorts teratas.
```

Yang terjadi:

- Runner menjalankan tugas itu.
- Hasil lengkap diposting ke **room sub-bot** (sebagai pesan sub-bot,
  diawali "Perintah dari Chief: ...").
- Salinan terusan diposting ke **room Chief** ("Diteruskan ke ...").

Tanpa `@target`, hasil hanya ada di room Chief. Target yang tidak
dikenal tidak akan dijalankan — Chief akan menerima pesan error
yang menyebutkan daftar sub-bot yang valid.

> Tips: `@target` memakai **id bot** (huruf kecil, mis.
> `@yt-analytics`), bukan nama tampilannya. Id bot bisa dilihat di
> daftar bot / room aplikasi.

## Yang terjadi di balik layar

1. Runner mengecek room tiap 15 detik.
2. Ketemu perintah `RUNNER:` di room Chief tanpa balasan asisten
   (atau, di mode otomatis, pesan baru apa pun di room Chief).
3. Menunggu 90 detik (grace) — memberi kesempatan loop aplikasi
   menjawab dulu kalau aplikasi ternyata masih terbuka.
4. Mengklaim tugas (tugas yang sudah diklaim tidak pernah diulang,
   bahkan setelah Runner restart).
5. Menjalankan model + tool komputer di server (maks 8 ronde).
6. Mengecek ulang: kalau aplikasi sudah menjawab duluan, hasil
   Runner dibuang (tidak dobel posting).
7. Memposting balasan ke room Chief (dan room sub-bot bila delegasi).

## Menjalankan Runner

Di PC, dari folder tempat file Runner berada:

```bash
setsid nohup python3 runner_service.py > /tmp/runner-mvp.log 2>&1 < /dev/null &
```

Cek log:

```bash
tail -20 /tmp/runner-mvp.log
```

Cek job terakhir:

```bash
curl http://127.0.0.1:8791/jobs
```

## Menghentikan Runner

Ambil PID eksak dari `ps`, lalu kill (jangan pakai pola pgrep —
pola itu pernah salah membunuh shell wrapper):

```bash
PID=$(ps aux | awk '$11 == "python3" && $12 == "runner_service.py" {print $2}')
kill $PID
```

## Setelah PC reboot

Runner **tidak auto-start**. Setelah reboot, jalankan lagi secara
manual (perintah di atas). Server pendamping, browser tim, dan
noVNC juga mati saat reboot — itu pekerjaan rumah terpisah.

## Konfigurasi (environment)

| Variabel | Default | Arti |
|---|---|---|
| `RUNNER_SERVER` | `http://127.0.0.1:8780` | Server pendamping |
| `RUNNER_MODEL_BASE_URL` | `http://127.0.0.1:3001/v1` | Endpoint model (OpenAI-compatible) |
| `RUNNER_MODEL` | `auto` | Nama model |
| `RUNNER_ENV_FILE` | `~/.hermes/.env` | File env tempat kunci model dibaca |
| `RUNNER_STATUS_PORT` | `8791` | Port status Runner |
| `RUNNER_POLL_SECONDS` | `15` | Interval cek room |
| `RUNNER_GRACE_SECONDS` | `90` | Grace sebelum klaim |
| `RUNNER_TRIGGER` | `RUNNER:` | Prefix perintah |
| `RUNNER_AUTO` | `0` | Mode otomatis: `1` = klaim pesan Chief tanpa prefix `RUNNER:`, aktifkan sekali saat start Runner |
| `RUNNER_CHIEF` | `xm` | Id bot Chief |
| `RUNNER_SCOPE` | `team` | Scope komputer |
| `RUNNER_MAX_ROUNDS` | `8` | Max ronde model+tool |
| `RUNNER_CLAIM_FILE` | `./runner-claims.json` | File klaim tugas |

Kunci model dibaca saat runtime dari `$SAMAI_API_KEY`, atau dari
file env (`RUNNER_ENV_FILE`). Nilainya tidak pernah dicetak di log.

## Troubleshooting

| Gejala | Penyebab umum / solusi |
|---|---|
| Perintah tidak jalan | Pastikan dikirim di **room Chief**, bukan room sub-bot. Perintah dari room lain diabaikan. Cek juga Runner hidup (`/health`). |
| Perintah tanpa `RUNNER:` tidak jalan | Pastikan Runner dijalankan dengan `RUNNER_AUTO=1` (mode otomatis). Kalau tidak, pakai prefix `RUNNER:`. |
| Balasan dobel | Aplikasi masih terbuka dan loop aplikasi menjawab setelah grace. Pola aman: kirim perintah, langsung tutup aplikasi. |
| Runner menjawab tanpa tool ("dari teks saja") | Komputer sedang dipegang user (kontrol bukan bot) — tool ditolak server. Lepas kontrol ke bot, lalu kirim ulang perintah. |
| Balasan "Runner gagal: ..." | Baca pesan gagalnya — biasanya model/endpoint tidak terjangkau. Perbaiki endpoint/key, lalu kirim ulang. |
| Runner mati | Cek log (`/tmp/runner-mvp.log`), lalu jalankan lagi. Setelah reboot PC, Runner memang harus dijalankan manual. |
| Target `@...` tidak dikenal | Pakai id bot yang benar. Pesan error Chief menyebutkan daftar yang valid. |

## Batasan (jujur)

- **Tanpa notifikasi push dan tanpa progres live.** Kamu tahu tugas
  selesai hanya saat membuka room.
- **Tanpa antrean prioritas / paralel.** Tugas jalan satu per satu,
  berurutan.
- **Konteks terbatas.** Runner mengirim max 12 pesan terakhir room
  sebagai konteks.
- **Hanya room mode chat dan scope team.**
- **Model gratis bisa lemah tool-calling.** Kalau model tidak
  mengembalikan `tool_calls`, Runner menjawab dari teks dan
  melaporkannya — bukan diam-diam gagal.

## Keamanan

- Runner adalah **klien HTTP murni**: tidak mengimpor kode server,
  tidak menyentuh folder data/karakter/perangkat, tidak mengubah
  server pendamping.
- Runner **tidak pernah** memanggil take-control / release-control
  / login-vault. Tool komputer ditolak server sendiri (409) bila
  user yang memegang kontrol.
- Tool login (vault) sengaja tidak disediakan — Runner tidak pernah
  login pakai kredensial atas nama kamu.

## File terkait

- `server/runner_service.py` — service Runner (Python stdlib saja).
- `RUNNER-DIRECTIONS.md` — desain lengkap (dokumen kerja).
- `server/runner-mvp-test.md` — bukti test.
