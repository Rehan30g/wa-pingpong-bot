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

Gambar, GIF, video, dan stiker (langsung atau dikutip/reply) diunduh sebagai data URL dan dikirim ke GLM sebagai konten multimodal (`image_url`/`video_url`). Media terbaru dari percakapan aktif juga dikirim kembali pada request berikutnya; jumlahnya dibatasi `AI_HISTORY_MEDIA_LIMIT` (default 4). Jev menerima `media_kind`, `media_format`, `is_sticker`, `is_attachment`, dan `is_gif`, sehingga reaction sticker/GIF dapat dibedakan dari lampiran yang perlu dianalisis. Batas ukuran tiap media diatur `AI_MAX_MEDIA_MB` (default 20 MB).

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
