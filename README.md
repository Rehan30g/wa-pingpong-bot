# Grad — agen WhatsApp grup

Bot WhatsApp (Baileys) bernama **Grad** yang ikut ngobrol di grup dan DM seperti anggota biasa, tapi bisa bekerja: mencari di web, mendengar voice note, mengingat, membuat jadwal, mengolah media, menjalankan Python, dan mengoleksi stiker sendiri. Tidak ada perintah yang perlu dihafal — cukup mention, sebut namanya, atau reply.

```text
Pesan WA ─► Jev (typesafe/jev-1.13): diam · reaction · balas · masuk sendiri (bantu/nimbrung)
               └─► Agent loop GLM (z-ai/glm-5.3-flash) + tools ─► kirim ke chat asal
Voice note ─► Gemini Flash Lite (telinga) ─► transkrip ─► Jev/GLM
```

## Yang bisa dilakukan

| Kemampuan | Contoh | Fitur (`/fitur`) |
|---|---|---|
| Cari info terbaru & rangkum link | "@Grad harga iPhone 17 sekarang? bandingin sama 16" | `web` |
| Dengar voice note | kirim VN "grad besok rapat jam berapa?" | `audio` |
| Lihat gambar/video | reply foto "@Grad ini error apa?" | `media` |
| Koleksi stiker sendiri | "@Grad simpan stiker ini", "kirim stiker dong", "hapus stiker itu" (owner/admin), sesekali membalas pakai stiker | `stiker` |
| Pengingat & jadwal (sekali/berulang, WIT) | "ingetin grup besok jam 8 rapat", "tiap Senin jam 7 cariin jadwal bola" | `reminder` |
| Ingat fakta & catatan | "inget ya aku alergi udang", "catat keputusan rapat tadi" | `memori` |
| Edit video/GIF/audio (FFmpeg) | "jadiin stiker video ini, 3 detik pertama, tulis GAS", "ambil audionya jadi mp3" | `edit_media` |
| Python: hitung, grafik, QR, API | "bikin grafik kurs USD/IDR 7 hari terakhir", "bikinin QR buat link ini" | `python` |
| Tugas latar panjang (subagent) | "riset mendalam bandingin 3 laptop gaming + grafik harga" | `latar` |
| Ikut nimbrung / bantu tanpa dipanggil | Grad kadang menimpali candaan (sering pakai stiker) atau menjawab pertanyaan terbuka | `sosial` |
| Baca & buat dokumen | kirim PDF/Word/PPT/Excel lalu "ringkas ini", "slide berapa bahas anggaran?"; "jadiin notulen tadi PDF", "bikin 5 slide dari riset tadi", "export ke excel" (PDF hasil scan dibaca OCR) | `dokumen` |
| Skill siap pakai | "250 dolar berapa rupiah?", "cuaca jayapura besok", "maghrib jam berapa", "patungan dong: …", "qr wifi RumahKita pw …", "bikin notulen rapat tadi" | `skill` |
| Hasil ke DM peminta | "kirim ke DM aku aja" | — |

Hentikan tugas yang sedang jalan: "stop"/"batal". Minta Grad berhenti nimbrung: "grad diem dulu".

## Menjalankan (laptop atau VPS)

1. Node.js 20+ (dev memakai 26), `ffmpeg` + `ffprobe` di PATH.
2. `npm install`
3. Salin `.env.example` ke `.env`, isi `OPENROUTER_API_KEY`, `BOT_NAME`, `BOT_ROLE`. Kosongkan `OPENROUTER_PROXY_URL` bila mesin bisa akses OpenRouter langsung (VPS di AGENTS.md butuh proxy).
4. Untuk Python & dokumen: `npm run python:setup` (unduh paket Pyodide + library dokumen sekali; ulangi setelah update yang menambah paket).
5. `npm start`, scan QR, kirim `/verify` dari WhatsApp, masukkan kode di terminal, lalu `/allow` di grup.
6. Dashboard owner: buka link `http://127.0.0.1:7777/?t=…` yang dicetak di terminal (atau `npm run dashboard:link`). Di VPS lewat SSH tunnel: `ssh -N -L 7777:127.0.0.1:7777 <user>@<vps>`.

## Perintah

| Siapa | Perintah |
|---|---|
| Semua | `/menu`, `/react <emoji>`, `/qr <teks>`, `/s` (reply gambar → stiker), `/fitur` (status fitur grup), game `/start` `pong` `/score` `/stop` |
| Owner, admin grup, pemegang veto | `/memory`, `/clear`, `/reset` |
| Admin grup (via DM ke Grad) | `/grup`, `/fitur <no>`, `/fitur <no> <fitur> on\|off` |
| Owner | `/agent status\|on\|off\|clear`, `/agent social on\|off`, `/stiker` (+ `lihat\|buang <id>`, `kurasi`, `review`), `/fitur global [<fitur> kunci\|buka]`, `/allow`, `/deny`, `/veto` `/unveto` `/veto list`, `/owner`, `/verify`, `/reboot` |

`/task <permintaan>` masih diterima sebagai alias mention.

## Keamanan (ditegakkan di kode)

- Balasan hanya ke **chat asal**; satu pengecualian: **DM peminta sendiri** bila dia memintanya. Tidak ada tool untuk mengirim ke orang atau grup lain.
- DM hanya untuk nomor yang pernah aktif di grup yang diizinkan (whitelist); opt-out dihormati; permintaan broadcast ditolak.
- Fitur bisa dimatikan per grup (admin/owner) dan dikunci global (owner); tools fitur yang mati tidak pernah dikirim ke model.
- `web_fetch`/HTTP Python menolak IP privat/lokal di setiap redirect (anti SSRF).
- Python jalan di Pyodide + permission model Node: tanpa akses file bot, tanpa jaringan langsung, tanpa env rahasia. FFmpeg hanya lewat operasi yang dikurasi.
- Batas per tugas (langkah, waktu, biaya) dan budget harian; "stop" menghentikan loop.
- Secret tidak pernah dicetak atau ditampilkan di dashboard.

## Struktur

| Path | Isi |
|---|---|
| `index.js` | koneksi WhatsApp, identitas pengirim, command, pengiriman ke agen |
| `ai/group-agent.js`, `ai/direct-agent.js` | alur grup & DM: Jev → agent loop → kirim |
| `ai/agent/` | loop, tools, format WA, jadwal, proaktif, tugas latar, pemakaian/budget |
| `ai/audio/` | transkripsi voice note (telinga) |
| `ai/stickers/` | koleksi stiker: pengumpulan, kurasi, pemakaian, command |
| `ai/memory/notebook.js`, `ai/memory-store.js` | fakta, catatan, memori compact |
| `ai/sandbox/` | Python sandbox + HTTP aman |
| `ai/documents/reader.js` | pembaca dokumen (sandbox) + OCR PDF scan |
| `ai/skills/` | skill bawaan (`builtin/*.md`); skill tambahan owner di `data/skills/` |
| `ai/media/media-edit.js` | editor FFmpeg |
| `ai/features*.js`, `ai/runtime-settings.js` | fitur per grup, pengaturan runtime |
| `ai/dashboard/` | dashboard owner lokal |
| `Plan.md` | rencana & status milestone |
| `AGENTS.md` | panduan teknis lengkap untuk agen/pengembang |

## Tes & simulasi

```bash
npm test
```

Tes tidak pernah memakai API key asli. Validasi dengan API nyata (tanpa WhatsApp): `npm run simulate:agent`, `npm run simulate:skills`, `npm run simulate:documents -- <file>`, `npm run probe:tools`, `npm run probe:audio -- <file>`. Dokumen overhaul v1 (arsip) ada di [`docs/overhaul/`](./docs/overhaul/).
