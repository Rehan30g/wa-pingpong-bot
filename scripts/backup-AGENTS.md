# AGENTS.md — repo backup Grad

Panduan untuk AI agent (dan manusia) yang memulihkan bot **Grad** ke server baru.

## Konteks
- **Grad** = bot WhatsApp grup/DM berbasis AI (Node.js + Baileys). Kode ada di repo publik
  `https://github.com/Rehan30g/wa-pingpong-bot` (branch terbaru, lihat PR/branch yang paling baru).
  Panduan teknis lengkap ada di `AGENTS.md` dan `CLAUDE.md` repo kode itu — baca setelah clone.
- **Repo ini** (`Rehan30g/grad-backup`, PRIVAT) hanya berisi backup data terenkripsi, dibuat otomatis
  tiap hari 03.00 WIT (18.00 UTC) oleh `scripts/backup.sh` di server bot. Satu commit yang ditimpa
  (force-push), berisi maksimal 7 cadangan terakhir di `backups/` + `SHA256SUMS`.
- Server lama: VM Ubuntu 22.04 (VMware), Node.js v22, user `ubuntu`, folder `/home/ubuntu/GITKARA2.1`,
  bot jalan di tmux `wabot` (auto-restart) dan dinyalakan saat boot lewat crontab `@reboot`.
- Owner bot: Rehan (`Rehan30g`). Jam operasional memakai WIT (UTC+9).

## Isi tiap backup (`grad-<UTC>.tar.gz.enc`)
AES-256-CBC (openssl, PBKDF2 300.000 iterasi). Setelah dibuka, folder `grad/` berisi:
| Path | Isi |
|---|---|
| `ai-memory.json` | memori Grad: grup, DM, profil orang, nama panggilan, owner, pemakaian |
| `data.json` | owner, grup yang diizinkan, akses veto |
| `features.json` | fitur per grup |
| `agent-jobs.json` | jadwal/pengingat |
| `.env` | API key OpenRouter & konfigurasi (RAHASIA) |
| `auth/` | sesi WhatsApp (RAHASIA) — tanpa ini bot harus scan QR ulang |
| `data/stickers/` | koleksi stiker + `stickers.db` (SQLite) |
| `data/notebook.json`, `data/runtime-settings.json`, `data/skills/`, `data/dashboard-token` | catatan, pengaturan, skill owner |

Tidak ikut (dibuat ulang): cache Pyodide (`npm run python:setup`), `node_modules`, log, folder kerja Python.

## Kata sandi backup
- Hanya owner yang memegangnya (disimpan di luar server). **Tidak ada di repo ini.**
- Agent: MINTA ke owner; jangan menebak, jangan menulisnya ke log/chat/commit.
- Di server, kata sandi disimpan di `~/.grad-backup-pass` (chmod 600) untuk backup harian.

## Memulihkan ke server baru
1. Prasyarat: Ubuntu 22.04+, Node.js 22, git, openssl, tmux, ffmpeg dengan filter `drawtext`
   (lihat AGENTS.md repo kode bagian VPS).
2. Clone kode: `git clone https://github.com/Rehan30g/wa-pingpong-bot.git /home/ubuntu/GITKARA2.1`,
   checkout branch terbaru, `npm install`.
3. Buka backup terbaru:
   ```bash
   git clone https://github.com/Rehan30g/grad-backup.git ~/grad-backup
   cd ~/grad-backup/backups && sha256sum -c SHA256SUMS
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -pass file:$HOME/.grad-backup-pass \
     -in "$(ls -1 grad-*.tar.gz.enc | tail -1)" | tar -xzf - -C /tmp
   cp -a /tmp/grad/. /home/ubuntu/GITKARA2.1/ && rm -rf /tmp/grad
   ```
4. `npm run python:setup`, lalu `npm test` (harus hijau).
5. Proxy: server lama butuh WARP + privoxy (`http://127.0.0.1:8118`) karena IP-nya diblok OpenRouter.
   Di server baru cek dulu `curl -s -o /dev/null -w '%{http_code}' https://openrouter.ai/api/v1/models`;
   kalau 200 tanpa proxy, kosongkan `OPENROUTER_PROXY_URL`/`HTTPS_PROXY`.
6. Jalankan: `./scripts/tmux-sessions.sh`, cek `tmux capture-pane -t wabot -p` sampai "Bot terhubung!".
   JANGAN menjalankan bot di dua server sekaligus dengan `auth/` yang sama (sesi WA saling tendang):
   matikan server lama dulu bila masih hidup.

## Memasang backup harian di server baru
```bash
# kata sandi dari owner, tanpa menampilkannya di layar:
read -rsp "Kata sandi backup: " P && printf %s "$P" > ~/.grad-backup-pass && chmod 600 ~/.grad-backup-pass && unset P
# akses push ke repo privat ini (token GitHub milik owner, scope repo):
#   simpan di ~/.netrc:  machine github.com login <user> password <token>   (chmod 600)
(crontab -l 2>/dev/null; \
 echo "@reboot sleep 20 && /home/ubuntu/GITKARA2.1/scripts/tmux-sessions.sh >> /home/ubuntu/GITKARA2.1/data/logs/boot.log 2>&1"; \
 echo "0 18 * * * /home/ubuntu/GITKARA2.1/scripts/backup.sh >> /home/ubuntu/GITKARA2.1/data/logs/backup.log 2>&1") | crontab -
/home/ubuntu/GITKARA2.1/scripts/backup.sh   # uji sekali; harus diakhiri "OK: ..."
```
`scripts/backup.sh` menguji membuka arsip sebelum push. Lihat hasil di `data/logs/backup.log`.

## Aturan
- Jangan pernah commit/push isi backup yang sudah dibuka (`grad/`, `.env`, `auth/`) ke repo mana pun,
  terutama repo kode yang PUBLIK.
- Jangan mencetak isi `.env`, token, atau kata sandi.
- Repo ini harus tetap PRIVAT.
