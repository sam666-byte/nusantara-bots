---
name: inbox-triage
description: Triage mail masuk per karakter menjadi kartu Kanban dan draf aksi — klasifikasi tugas/info/spam, tanpa kirim langsung; aksi eksternal hanya lewat approval queue.
version: 1.0.0
role: Inbox triage — mail masuk menjadi aksi yang bisa dilacak
skills:
  - inbox-triage
tools:
  - read_file
memory_scope: team
---

# Inbox triage

Ubah mail masuk menjadi aksi yang bisa dilacak: **klasifikasi → draf kartu Kanban → (bila perlu) approval**. Skill ini tidak pernah mengirim, meneruskan, atau menghapus mail sendiri. Mail di build ini receive-only; kirim/hapus adalah aksi eksternal yang selalu menunggu persetujuan manusia di approval queue.

## Apps

- **Mail** — ringkasan inbox per karakter (`GET /api/mail?character=<stem>` atau `?all=1`); hanya hitungan + alamat, bukan isi penuh. Satu label per karakter = stem file karakternya.
- **Kanban** — papan tugas (`GET /api/kanban`, `POST /api/triage/card`); kartu asal mail membawa `origin: {kind: "mail", ref: <message-id atau alamat pengirim>}`.
- **Approval queue** — `POST /api/approvals/request`; semua aksi `send`/`delete` diajukan ke sini, tidak pernah dieksekusi langsung.

## Trigger

- User meminta "triage inbox" (satu karakter atau semua karakter).
- Mail baru masuk dan user ingin tahu apa yang butuh aksi.
- Bukan trigger: penjadwalan otomatis. Triage jalan saat manusia memintanya; tidak ada cron di skill ini.

## Workflow

### 1. Ambil ringkasan inbox

Minta ringkasan per karakter lewat `GET /api/mail`. Bila bridge tidak tersedia (`available: false`), laporkan jujur "inbox tidak tersedia" — jangan mengarang isi mail, jangan mengarang jumlah.

### 2. Klasifikasi tiap item

Gunakan `app/triage.py::classify_mail_item` (aturan kata kunci, deterministik):

- **tugas** — mail meminta sesuatu (kata permintaan, tanda tanya, deadline). Prioritas 3 bila mendesak (`urgent`/`asap`/`deadline`/`segera`/`darurat`), 2 bila biasa.
- **info** — FYI, newsletter, notifikasi; tidak meminta aksi. Kartu prioritas rendah (1), sekadar jejak.
- **spam** — cocok dengan umpan junk yang dikenal (`you won`, `claim your prize`, `crypto giveaway`, dan sejenisnya). Spam TIDAK dijadikan kartu.

Aturan kejujuran: klasifikasi berbasis kata kunci bisa salah. Bila ragu antara tugas dan info, pilih **tugas** (lebih aman dilewatkan manusia daripada hilang), dan tulis alasannya di kartu.

### 3. Draf kartu Kanban

Untuk tiap item tugas/info, buat draf lewat `app/triage.py::mail_to_card_draft`, lalu buat kartunya via `POST /api/triage/card`. Kartu membawa:

- `title` — `Triage: <subjek>` (dipotong 250 karakter).
- `body` — pengirim, subjek, ringkasan, klasifikasi + alasan, dan (bila ada) **balasan draf**.
- `origin` — `{kind: "mail", ref: <message-id>}` atau `ref: "from:<pengirim>"` bila tidak ada message-id.
- `assignee` — karakter pemilik inbox, bila karakter itu valid; bila tidak, kosongkan dan catat labelnya di body.

### 4. Aksi eksternal — hanya lewat approval

- Bila klasifikasi menyarankan **balas** (`suggested_action: "send"` — ada pertanyaan/permohonan langsung), sertakan balasan draf di kartu, lalu ajukan approval (`action: "send"`, isi draf + `card_id` + `ref` mail). **Jangan kirim.**
- Bila klasifikasi **spam** (`suggested_action: "delete"`), jangan buat kartu; ajukan approval (`action: "delete"`, `ref` mail). **Jangan hapus.**
- Endpoint mengembalikan `approval_id` — sampaikan ke user supaya ia bisa menyetujui/menolak di antrean.

### 5. Serahkan ringkasan triage

Laporkan per karakter: berapa item, berapa tugas/info/spam, kartu apa yang dibuat (judul + `card_id`), approval apa yang diajukan (`approval_id`). Jangan klaim mail "sudah dibalas" atau "sudah dihapus" — yang terjadi baru draf + pengajuan.

## Output

1. **Kartu Kanban** (satu per item tugas/info) dengan `origin.kind: "mail"`.
2. **Approval request** (bila ada aksi send/delete) dengan `approval_id`.
3. **Ringkasan triage** — hitungan + daftar kartu + daftar approval, dalam bahasa user.

## Human review

Aksi berikut WAJIB lewat approval queue dan tidak pernah dilakukan skill ini sendiri: `send`, `publish`, `merge`, `deploy`, `delete`, `change-production-data`. Secara khusus:

- Balas/teruskan mail → approval `send`.
- Hapus mail (termasuk spam) → approval `delete`.
- Bila antrean approval belum tersedia (belum di-wire), laporkan itu sebagai blocker dan berhenti di draf kartu — jangan lanjutkan ke aksi apa pun.

**Mode always-approve:** pemilik dapat menyalakan mode always-approve untuk approval queue. Bila mode itu ON untuk bot/aksi ini, request approval tetap WAJIB diajukan lewat `/api/approvals/request` — tetapi langsung disetujui otomatis dan tetap tercatat di audit log (flag `auto=true`, alasan `always-approve`), sehingga alur tidak tertahan. Bila mode itu OFF, aksi menunggu persetujuan manusia seperti biasa. Mode ini tidak mengubah apa pun di skill ini: skill tetap tidak pernah mengirim/menghapus sendiri, dan tetap mengajukan request yang sama; yang berubah hanya kecepatan persetujuan di sisi antrean.

## Anti-patterns

- Mengirim balasan langsung dari skill ini (tidak ada jalur kirim di sini — dan memang tidak boleh ada).
- Menghapus mail tanpa approval, termasuk yang jelas spam.
- Mengarang message-id, pengirim, atau isi mail yang tidak ada di ringkasan.
- Menjadikan spam sebagai kartu Kanban.
- Mengklasifikasi newsletter biasa sebagai spam hanya karena ada kata "unsubscribe".
- Menyatakan mail "sudah ditindaklanjuti" saat yang ada baru draf kartu.
