# CLAUDE.md

Panduan teknis lengkap proyek ada di AGENTS.md (dimuat otomatis di bawah). File ini hanya berisi hal khusus cara kerja Claude Code di repo ini.

@AGENTS.md

## Cara kerja di repo ini

- **Bahasa**: komentar kode, pesan log, dan teks ke pengguna WhatsApp dalam bahasa Indonesia santai-sopan; ikuti gaya sekitar (komentar menjelaskan *kenapa*, bukan *apa*).
- **Lingkungan**: pengembangan & demo jalan di laptop Windows (`npm start`, Git Bash/PowerShell); deploy ke VPS hanya saat owner memutuskan. Jam = WIT (UTC+9).
- **Bot yang sedang jalan** menyimpan riwayat obrolan aktif hanya di RAM — restart menghapusnya. Jangan menjalankan `npm start` kedua bila bot sudah jalan dengan sesi `auth/` yang sama (sesi WA saling tendang).
- **Feature first**: setiap milestone ditutup dengan fitur yang aktif dan terasa di WhatsApp, bukan infrastruktur yang dimatikan. Status milestone ada di `Plan.md`.
- **Backup**: data Grad di-backup otomatis tiap hari ke repo privat `Rehan30g/grad-backup` (lihat AGENTS.md bagian Backup). Kalau menambah file data baru yang penting, tambahkan ke `scripts/backup.sh`. Kalau pindah server, ikuti `AGENTS.md` di repo backup.

## Sebelum menyatakan selesai

1. `node --check` untuk file yang diubah (minimal checklist di AGENTS.md).
2. `npm test` harus hijau. Tes alur pesan memanggil `processGroupMessage`/`processDirectMessage` dengan mock socket dan `test/helpers/mock-openrouter.js`; jangan pernah memakai key asli di tes (`test/helpers/test-env.js` mengosongkannya).
3. Perubahan perilaku AI divalidasi dengan API nyata lewat skrip simulasi (lihat AGENTS.md) — laporkan hasil nyata, termasuk yang gagal.
4. Perbarui `AGENTS.md`/`Plan.md`/`README.md`/`/menu` bila menambah fitur atau command.

## Jebakan yang sudah pernah terjadi

- Menyisipkan kode lewat heredoc + string JS sering menghilangkan backslash (`\d`, `\n`) atau mengubah `\b` menjadi karakter backspace tak terlihat — untuk regex dan template literal pakai Edit/Write langsung, lalu `node --check` (cek juga `grep -c $'\x08' <file>`).
- Parser env: `Number("")` = 0; pakai pola `envNumber` yang mengabaikan string kosong. Di tes, pulihkan env dengan `delete` bila nilai lama `undefined`.
- GLM mengabaikan `response_format` saat tools aktif → jawaban akhir loop teks bebas + penanda `[[reply:#id]]`.
- DNS lokal bisa mengembalikan IPv6 privat (`fd00::`) bersama IPv4 publik; `resolvePublic` memilih yang publik.
- Node ≥20 memanggil `lookup` dengan `{all:true}`; lookup kustom harus mendukung bentuk array.
- Jangan commit/push tanpa diminta; `.env`, `auth/`, `data/`, `features.json` tidak boleh masuk git.
