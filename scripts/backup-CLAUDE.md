# CLAUDE.md — repo backup Grad

Repo PRIVAT ini berisi backup terenkripsi data bot WhatsApp **Grad**. Panduan lengkap: @AGENTS.md
(konteks, isi backup, cara memulihkan ke server baru, cara memasang backup harian).

## Cara kerja di repo ini
- Bahasa ke owner: Indonesia santai-sopan. Jam = WIT (UTC+9).
- Tugas paling umum: **memulihkan bot ke server baru** → ikuti AGENTS.md langkah demi langkah,
  lalu baca `AGENTS.md`/`CLAUDE.md` di repo kode `Rehan30g/wa-pingpong-bot` untuk detail teknis.
- Kata sandi backup hanya dipegang owner: minta ke owner, simpan di `~/.grad-backup-pass` (chmod 600),
  jangan pernah menampilkan, mencatat, atau meng-commit-nya.
- Sebelum menyalin data, verifikasi `sha256sum -c SHA256SUMS` dan buka backup TERBARU.
- Jangan menjalankan bot di dua server sekaligus dengan sesi `auth/` yang sama; pastikan server lama mati.
- Setelah pulih: `npm test` hijau, bot "terhubung", lalu pasang lagi cron backup harian dan jalankan
  `scripts/backup.sh` sekali sampai log "OK".
- Jangan mengubah isi `backups/` secara manual; repo ini ditimpa otomatis oleh `scripts/backup.sh`.
