# WA Group Agent

Bot WhatsApp grup berbasis Baileys. Jev 1.13 membaca konteks percakapan dan memilih untuk diam, memberi reaction, atau menjawab. GLM 5.3 Flash hanya dipanggil ketika jawaban teks diperlukan.

## Menjalankan

1. Gunakan Node.js 20.
2. Jalankan `npm install`.
3. Salin `.env.example` menjadi `.env` dan ganti placeholder API key, nama, serta peran bot.
4. Jalankan `npm start`, lalu scan QR WhatsApp dari terminal.
5. Kirim `/verify`, masukkan kode di terminal, lalu kirim `/allow` di grup tujuan.

Bot menyimpan maksimal 10 pesan terbaru per grup di memori proses. Pesan cepat dikumpulkan selama 1,2 detik agar Jev membaca rangkaian percakapan, bukan chat satuan. Mention/reply eksplisit diprioritaskan; percakapan antarmanusia secara default dibiarkan tanpa interupsi.

Pesan dalam jendela debounce yang sama digabung; pesan yang datang saat Jev sedang mengevaluasi/membalas mengantri dan diproses setelahnya, dan evaluasi antrean yang basi (ada pesan lebih baru) dilewati. Read receipt (centang biru) dikirim setelah Jev menghasilkan keputusan untuk pesan itu, termasuk saat keputusannya ignore/ditolak; pesan yang belum pernah dievaluasi tetap belum terbaca, tetapi tetap mendapat centang abu-abu (delivered) saat diterima bot. Lanjutan percakapan langsung dengan bot dijawab meski confidence Jev rendah, dan konfirmasi singkat ("iyap", "sip") dalam dialog bot diberi reaction ack. Status bot dijaga tetap online lewat `markOnlineOnConnect` dan heartbeat presence berkala. Saat menjawab, bot menampilkan status mengetik selama GLM menyusun balasan. Reasoning GLM dikunci ke `low` melalui `GLM_REASONING_EFFORT`.

Saat menulis jawaban, GLM juga memilih `reply_to_entry_id`: ia dapat mengutip pesan aktif mana pun yang relevan, atau memilih `null` untuk mengirim bubble biasa tanpa quote. Pesan terbaru tidak otomatis dikutip.

Setelah percakapan aktif mencapai ambang compact, GLM diam-diam memperbarui dua memori persisten: konteks terperinci untuk GLM dan konteks keputusan ringkas untuk Jev. `/clear`, `/reset`, dan `/memory` dapat digunakan owner, admin grup WhatsApp, atau anggota yang diberi akses veto oleh owner. Owner memberi akses dengan reply `/veto` atau `/veto 628xxx`, mencabutnya dengan `/unveto`, dan melihatnya lewat `/veto list`. Clear/reset juga membatalkan evaluasi AI lama yang masih berjalan atau mengantre.

## Alur AI

```text
Pesan grup -> Jev -> diam / reaction / reply -> GLM 5.3 Flash (hanya untuk reply)
```

Jika Jev gagal, bot hanya mencoba menjawab bila pesan me-mention bot atau merupakan reply ke pesan bot. Jika GLM gagal, bot tidak mengirim jawaban palsu.

Gambar, GIF, dan stiker (langsung atau dikutip/reply) dikirim sebagai `image_url`. Video dikonversi menjadi satu frame JPEG dengan ffmpeg; jika ffmpeg tidak tersedia atau konversi gagal, bot hanya memakai metadata dan tidak mengklaim telah menonton video. Video base64 tidak dikirim ke OpenRouter. Media aktif terbaru dibatasi `AI_HISTORY_MEDIA_LIMIT` (default 4). Jev menerima klasifikasi media; ukuran unduhan dibatasi `AI_MAX_MEDIA_MB` (default 20 MB).

Runtime agen memiliki `web_search`, `web_fetch`, `fetch_media_from_url`, `fetch_media_from_message`, `make_sticker`, dan `send_asset` yang nonaktif secara default. Owner mengaktifkan flag masing-masing di `.env`; dua capability URL juga memerlukan allowlist hostname HTTPS. `/task cari web <query>` mencari informasi publik lewat OpenRouter dengan sitasi sumber; query yang tampak mengandung rahasia/data pribadi ditolak. Perintah `/task media` membaca gambar pada pesan sumber atau kutipannya; `/task stiker` membuat asset WebP 512×512; `/task kirim stiker` mengantrekan pengiriman ke chat asal melalui outbox. Task pengiriman tetap `verifying` sampai receipt transport diterima, dan menjadi `delivery_uncertain` bila proses terputus setelah send. Asset dibatasi scope chat/task dan TTL; shadow memakai root terpisah.

Gate lokal otomatis Fase 4 lulus; kuota egress tersimpan di SQLite, gambar diverifikasi dengan decode terpisah, dan mock transport telah menguji receipt serta pemulihan crash. Ini belum mencakup uji WhatsApp langsung oleh pengguna atau izin rollout. Lihat [`PHASE4_MEDIA_WEB_REPORT.md`](./docs/overhaul/PHASE4_MEDIA_WEB_REPORT.md) untuk batas bukti dan hasil tes.

Rencana capability file/media/storage/Python tersedia di [`Plan.md`](./Plan.md). Scaffolding nonaktif-by-default berada di `ai/capabilities/`.

## Chat Pribadi, Memori, dan Agen

Grad menyimpan memori terpisah per grup, per orang, dan antar hubungan di `ai-memory.json` (versi 2). Saat compact grup, GLM juga mengekstrak profil orang dan ringkasan hubungan sehingga Grad terasa satu AI yang mengenal siapa-siapa.

Di chat pribadi, mekaniknya berbeda: karena pesan jelas ditujukan ke bot, Grad membalas lebih sering (bukan menunggu disebut), namun tetap natural — jeda balas, presence mengetik, dan sesekali memecah balasan. Reminder sederhana seperti "ingetin aku 30 menit lagi" otomatis terjadwal.

**Safety DM yang wajib dipertahankan:**

- Grad hanya boleh membalas atau memulai DM ke nomor yang pernah mengirim pesan di grup yang diizinkan. Orang asing yang DM dibiarkan tanpa balasan.
- Permintaan menyebarkan/mem-forward pesan ke banyak orang ditolak dengan template tetap. Tidak ada API kirim ke target selain lawan chat.

`ai/scheduler.js` menjalankan job persisten (`reminder`, `follow_up`, `proactive_checkin`). DM proaktif melewati gerbang whitelist, `opt_out`, jam tenang WIT, cooldown per orang, dan kuota harian. Owner mengontrol lewat `/agent status`, `/agent on`, `/agent off`, dan `/agent clear`.

## Tes

```bash
npm test
```

## Demo agen tanpa WhatsApp

Jalankan `npm run agent:headless` untuk mencoba `/task catat`, `/task baca`, dan `/task ringkas` di terminal. Ini memakai API GLM asli, SQLite sementara di direktori temp, dan mode shadow tanpa socket WhatsApp. Ketik `/exit` untuk menutup sesi; data demo dihapus. Untuk satu tugas: `npm run agent:headless -- --once "/task catat: Rapat Jumat jam 9 WIT"`. Siapkan `OPENROUTER_API_KEY` seperti simulasi lain; key tidak dicetak. Demo ini terpisah dari `RUNTIME_ENGINE_MODE` bot WhatsApp.

# Status overhaul AI Agent

Runtime produksi tetap `legacy`. Gate lokal Fase 0–5 sudah dilaporkan; Fase 6 `run_python` sengaja tidak disertakan karena sandbox container belum teruji. Fase 7 belum lulus shadow/canary WhatsApp. Semua laporan overhaul ada di [`docs/overhaul/`](./docs/overhaul/): [`STATUS_OVERHAUL.md`](./docs/overhaul/STATUS_OVERHAUL.md), [`PHASE5_MEMORY_PROACTIVE_REPORT.md`](./docs/overhaul/PHASE5_MEMORY_PROACTIVE_REPORT.md), [`PHASE6_SANDBOX_DECISION.md`](./docs/overhaul/PHASE6_SANDBOX_DECISION.md), dan [`PHASE7_RELEASE_GATE_REPORT.md`](./docs/overhaul/PHASE7_RELEASE_GATE_REPORT.md). Jalankan `npm run evaluate:release` untuk evaluasi 60 skenario lokal; hasilnya tidak mengaktifkan rilis.
