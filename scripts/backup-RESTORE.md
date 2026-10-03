# Memulihkan Grad dari backup

Backup dibuat otomatis tiap hari 03.00 WIT oleh `scripts/backup.sh` di VPS bot.
Setiap berkas `backups/grad-<waktu>.tar.gz.enc` terenkripsi AES-256 dengan **kata sandi backup**
yang disimpan owner di luar VPS. Tanpa kata sandi itu backup tidak bisa dibuka.

## 1. Siapkan mesin baru
```bash
git clone https://github.com/Rehan30g/wa-pingpong-bot.git GITKARA2.1
cd GITKARA2.1 && npm install
```

## 2. Buka backup terbaru
```bash
git clone https://github.com/Rehan30g/grad-backup.git
cd grad-backup/backups && sha256sum -c SHA256SUMS
openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -in "$(ls -1 grad-*.tar.gz.enc | tail -1)" | tar -xzf -
# (masukkan kata sandi backup saat diminta)
```

## 3. Salin ke folder bot
```bash
cp -a grad/. ../../GITKARA2.1/
```
Isinya: `ai-memory.json`, `data.json`, `features.json`, `agent-jobs.json`, `.env`, `auth/` (sesi WhatsApp,
jadi tidak perlu scan QR), `data/stickers/`, `data/notebook.json`, `data/runtime-settings.json`, `data/skills/`.

## 4. Siapkan ulang yang tidak ikut di-backup
```bash
cd GITKARA2.1
npm run python:setup             # cache Pyodide
./scripts/tmux-sessions.sh       # jalankan bot di tmux
(crontab -l 2>/dev/null; echo "@reboot sleep 20 && $PWD/scripts/tmux-sessions.sh >> $PWD/data/logs/boot.log 2>&1"; echo "0 18 * * * $PWD/scripts/backup.sh >> $PWD/data/logs/backup.log 2>&1") | crontab -
```
Lalu simpan kata sandi backup ke `~/.grad-backup-pass` (chmod 600) supaya backup harian jalan lagi.
VPS lama memakai proxy WARP + privoxy untuk OpenRouter (lihat AGENTS.md bagian Proxy).
