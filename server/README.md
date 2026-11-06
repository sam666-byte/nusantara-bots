# Server — Nusantara Bots (pendamping)

Server pendamping untuk aplikasi Android **Nusantara Bots**. Server ini yang menyediakan fitur bot, rooms, memory, MCP, approvals, dan Team Computer ke aplikasi HP. Aplikasi tetap bisa dipakai untuk chat model langsung (BYOK) tanpa server — server hanya dibutuhkan kalau mau fitur-fitur itu.

Server ditulis murni dengan **Python standard library** (tanpa dependensi pihak ketiga).

## Yang dibutuhkan

- Python 3.11+ (diuji di 3.12 / 3.14)
- Tidak perlu `pip install` apa pun — semua modul berasal dari stdlib.

## Cara jalanin

```bash
# 1. Clone repo ini
git clone https://github.com/sam666-byte/nusantara-bots.git
cd nusantara-bots/server

# 2. (Opsional, untuk akses dari HP) buat file token — satu baris, rahasia
echo -n "token-rahasia-kamu" > /path/to/token
chmod 600 /path/to/token

# 3. Jalankan server (dengan token — tanpa OPEN_LAN, supaya
#    token tetap aktif; OPEN_LAN=1 justru mematikan token)
GROKBOT_APP_HOST=0.0.0.0 \
GROKBOT_APP_TOKEN_FILE=/path/to/token \
python3 -u app/server.py
```

> Kalau server gagal start dengan `ModuleNotFoundError: No module
> named 'cryptography'`, pasang dulu: `pip install cryptography`
> (vault membutuhkannya; tanpa itu server tidak jalan).

Server jalan di port **8780** (`http://<alamat-server>:8780`).

> Tanpa token, server hanya bind loopback (`127.0.0.1`) dan tidak bisa diakses dari HP. Itu disengaja — pengaman default. `GROKBOT_APP_OPEN_LAN=1` adalah opt-in khusus LAN **tanpa** token — jangan dipakai bersama token, dan jangan pernah dipakai di internet publik.

## Access token

Kalau server di-bind ke LAN (`0.0.0.0`) supaya bisa diakses dari HP, server **wajib pakai access token**. Token dibaca dari env var, bukan dari kode:

| Cara | Contoh |
|---|---|
| File token (disarankan) | `GROKBOT_APP_TOKEN_FILE=/path/to/token` |
| Env var | `GROKBOT_APP_TOKEN=<token-rahasia>` |

Token **tidak pernah** di-print di log dan **tidak pernah** di-commit ke repo. Simpan di luar repo (file `chmod 600` atau env var).

**Di aplikasi HP** — buka pengaturan server, isi **Server URL** (`http://<alamat-server>:8780`) + **Access Token** (isi file token di atas), lalu simpan. Aplikasi mengirim token itu lewat header `X-Grokbot-Token` di setiap request.

**Kalau muncul `401 - Simpan akses token dahulu`:** artinya token belum disimpan di aplikasi (atau salah). Copy token dari server, paste di pengaturan server aplikasi, simpan, coba lagi.

> 💡 Token akses server ini **beda** dengan API key model (BYOK). Token server = izin memakai server pendamping kamu. API key model = izin memakai model AI. Kamu butuh keduanya kalau pakai server + chat model.

## Server jauh (remote)

Aplikasi tidak membatasi Server URL ke localhost — URL apa pun
yang bisa dijangkau HP bisa dipakai, termasuk server di VPS /
box cloud (mis. Instabox) yang mengekspos port 8780. Yang
berubah cuma caranya diakses, bukan kodenya.

1. Di box jauh: clone repo, `cd server`, lalu jalankan server
   dengan token (tanpa `OPEN_LAN`):
   ```bash
   GROKBOT_APP_HOST=0.0.0.0 \
   GROKBOT_APP_TOKEN_FILE=$HOME/nusantara-token \
   python3 -u app/server.py
   ```
   File token: satu baris rahasia, `chmod 600`, di luar repo.
2. Ekspos port **8780 lewat HTTPS** — jangan `http://<ip>:8780`
   telanjang di internet publik (token dan isi chat lewat
   cleartext). Pilih salah satu:
   - **URL publik Instabox** untuk port 8780 (sudah HTTPS), atau
   - **reverse proxy HTTPS** (mis. Caddy) di depan server, atau
   - **Tailscale** (`http://100.x.x.x:8780` di dalam tailnet).
   URL publik Instabox bukan rahasia — siapa pun yang punya
   link-nya bisa menjangkau server — jadi token tetap wajib.
3. Di aplikasi: Pengaturan → **Server URL** = URL HTTPS tadi,
   **Access Token** = isi file token, lalu **Tes koneksi**.
   Aplikasi akan memperingatkan kalau kamu memakai `http://` ke
   host publik.
4. **Jangan pernah** pakai `GROKBOT_APP_OPEN_LAN=1` untuk server
   jauh — mode itu mematikan token sepenuhnya, dan server akan
   mencetak peringatan saat start. Team Computer (VNC/browser)
   tetap ditujukan untuk mesin lokal dan tidak ikut pindah ke
   server jauh.

Runner dengan server jauh (opsional): jalankan Runner di box
yang sama dengan env berikut (bukan default localhost-nya):

```bash
RUNNER_SERVER=https://alamat-box-kamu:8780 \
RUNNER_SERVER_TOKEN=<isi-file-token> \
RUNNER_MODEL_BASE_URL=<base-url-model-kamu> \
RUNNER_MODEL=<model> \
SAMAI_API_KEY=<redacted> \
python3 server/runner_service.py
```

## Struktur

```
server/
├── app/            # server.py (HTTP server) + modul pendukung
│   ├── server.py       # entry point — jalankan file ini
│   ├── auth.py         # token + bind (loopback vs LAN)
│   ├── chat_store.py   # penyimpanan chat
│   ├── computer.py     # Team Computer (VNC/browser bridge)
│   ├── mcp_client.py   # client MCP
│   ├── vault_store.py  # credential vault
│   └── tests/          # unit test (unittest)
├── learning/       # learning loop + distilasi
├── routines/       # scheduler / routines
├── snapshots/      # snapshot mesin
├── computers/      # registry mesin + merge devices
├── approvals/      # antrean persetujuan
├── costs/          # cost ledger (perkiraan biaya model)
├── grounding/      # grounding konteks
├── office/         # duty, health, kanban, presence, circuit breaker
├── packs/          # skill packs
├── plans/          # plan store
├── push/           # push notification (FCM)
├── templates/      # template resolver
├── vault/          # vault store
├── loader/         # loader karakter + skill
└── memory/         # memory store
```

Data runtime (chat, memory, karakter, settings) tersimpan di folder `data/` dan `characters/` yang dibuat otomatis saat server pertama kali jalan — **folder-folder itu tidak ada di repo** (data pengguna, jangan di-commit).

## Tes

```bash
cd server
python3 -m unittest discover -s app/tests -v
python3 -m unittest discover -s learning/tests -v
# ... dst per package, atau:
find . -name "test_*.py" -not -path "*__pycache__*" | head
```

## Keamanan

- Jangan pernah commit file token, `.env`, `*.key`, `*.pem`, atau isi folder `data/` / `characters/` ke repo.
- Token server hanya lewat env var / file — jangan hardcode di kode.
- Server ini ditujukan untuk dipakai di jaringan sendiri (LAN / Tailscale), bukan diekspos langsung ke internet publik tanpa proteksi tambahan. Kalau diekspos (lihat "Server jauh (remote)" di atas): token wajib, `OPEN_LAN=1` dilarang, dan port 8780 hanya lewat HTTPS.
