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

Setelah percakapan aktif mencapai ambang compact, GLM diam-diam memperbarui dua memori persisten: konteks terperinci untuk GLM dan konteks keputusan ringkas untuk Jev. `/clear` hanya membersihkan percakapan aktif, `/reset` membersihkan percakapan dan memori, sedangkan `/memory` menampilkan keduanya beserta waktu compact dalam WIT.

## Alur AI

```text
Pesan grup -> Jev -> diam / reaction / reply -> GLM 5.3 Flash (hanya untuk reply)
```

Jika Jev gagal, bot hanya mencoba menjawab bila pesan me-mention bot atau merupakan reply ke pesan bot. Jika GLM gagal, bot tidak mengirim jawaban palsu.

Gambar dan video (dikirim langsung atau dikutip/reply) diunduh sebagai data URL dan dikirim ke GLM sebagai konten multimodal (`image_url`/`video_url`), sehingga GLM bisa melihat isi media saat membalas. Media tanpa caption diproses dengan teks `[mengirim gambar]`/`[mengirim video]`. Batas ukuran media diatur `AI_MAX_MEDIA_MB` (default 20 MB). Jev tetap berbasis teks dan hanya menerima sinyal `has_image`/`has_video`.

## Tes

```bash
npm test
```
