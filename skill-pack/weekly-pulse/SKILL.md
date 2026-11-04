---
name: weekly-pulse
description: Susun draf ringkasan mingguan dari Kanban, memory, dan mail — apa selesai, apa tertahan, apa butuh keputusan; draf saja, manusia yang memutuskan kirim/publish.
version: 1.0.0
role: Weekly pulse — ringkasan mingguan proyek dari data yang ada
skills:
  - weekly-pulse
tools:
  - read_file
memory_scope: team
---

# Weekly pulse

Susun **draf ringkasan mingguan** dari tiga sumber yang sudah ada: Kanban (apa selesai/tertahan), memory (berapa fakta tercatat), dan mail (ringkasan inbox). Outputnya hanya draf yang ditampilkan di deck — skill ini tidak mengirim, tidak mem-publish, dan tidak mengubah data apa pun.

## Apps

- **Kanban** — papan + kartu (`GET /api/kanban` atau `GET /api/pulse/weekly`); status kartu dan evidence-nya adalah sumber kebenaran soal "selesai".
- **Memory** — hitungan fakta per scope (`team` + scope privat per karakter); hanya hitungan, bukan isi penuh, kecuali user memintanya.
- **Mail** — ringkasan inbox per karakter (`GET /api/mail?all=1`); hitungan total + belum dibaca, plus ketersediaan bridge.

## Trigger

- User meminta "weekly pulse" / "ringkasan mingguan".
- Ritme mingguan yang diminta manusia (bukan cron otomatis — skill ini tidak menjadwalkan dirinya sendiri).

## Workflow

### 1. Kumpulkan tiga sumber

- **Kanban**: ambil board lengkap (`columns` + `counts` + `unproven_done`). Pisahkan kartu `done` menjadi **proven** (done + ≥1 evidence) dan **unproven** (done + 0 evidence) — aturan yang sama dengan `office/kanban.py::verdict`. Kartu `blocked` dan kartu review dicatat terpisah.
- **Memory**: hitung fakta `team` dan total semua scope.
- **Mail**: ambil ringkasan per karakter (total + belum dibaca + `available`).

Bila satu sumber tidak tersedia (mis. bridge mail mati), tulis "tidak tersedia" di draf — jangan isi dengan angka tebakan, jangan sembunyikan kekosongan itu.

### 2. Susun draf

Gunakan `app/pulse.py::compose_pulse(kanban_board, memory_stats, mail_summaries)`. Draf berisi:

1. **Selesai — terbukti**: kartu done dengan evidence.
2. **Selesai — tanpa bukti**: kartu done tanpa evidence (masuk juga ke "butuh keputusan").
3. **Tertahan / blocked**: kartu blocked.
4. **Dalam review** dan **sedang dikerjakan**.
5. **Butuh keputusan**: gabungan blocked + selesai-tanpa-bukti.
6. **Memory**: hitungan fakta team + total.
7. **Mail**: per karakter, total + belum dibaca (atau "tidak tersedia").

Draf ditandai `sent: false` — itu fakta, bukan hiasan: tidak ada yang dikirim saat draf dibuat.

### 3. Tampilkan di deck

Kembalikan draf (JSON + teks markdown `body`) lewat `GET /api/pulse/weekly` untuk ditampilkan di deck. Manusia membaca, mengoreksi, lalu memutuskan.

## Output

1. **Draf ringkasan mingguan** — JSON (`counts`, daftar judul per seksi, `needs_decision`, hitungan memory/mail) + teks markdown siap tampil.
2. **Catatan kejujuran** — sumber mana yang tidak tersedia saat draf dibuat, bila ada.

## Human review

- Kirim/publish ringkasan ini ke siapa pun (mail, Threads, chat) adalah aksi `send`/`publish`: **manusia yang memutuskan, lewat approval queue bila mau dikirim**.
- Skill ini tidak pernah mengirim draf, tidak pernah menandai kartu selesai, dan tidak pernah menambah/mengubah memory.
- Bila manusia mengoreksi draf (mis. "kartu X sebenarnya belum selesai"), koreksi itu milik manusia — catat sebagai keputusan, jangan diam-diam ubah status kartu.

## Anti-patterns

- Mengklaim kartu selesai sebagai "proven" padahal tanpa evidence — done tanpa bukti = **unproven**, bukan proven.
- Mengarang angka memory/mail saat sumbernya tidak tersedia.
- Mengirim atau mem-publish draf tanpa perintah manusia.
- Menulis ringkasan dari ingatan ("kayaknya minggu ini...") alih-alih dari data board/memory/mail.
- Menyembunyikan kartu blocked/unproven supaya ringkasan terlihat bagus.
