#!/usr/bin/env bash
# Backup terenkripsi data Grad ke repo GitHub privat (owner 3 Okt 2026: "VPS ini bisa
# hilang tanpa alasan"). Isi: memori, owner/grup, fitur, jadwal, catatan, pengaturan,
# koleksi stiker, sesi WhatsApp (auth/) dan .env. Cache Pyodide, log, dan folder kerja
# tidak ikut (bisa dibuat ulang). Dijalankan cron tiap hari 03.00 WIT (18.00 UTC).
#
# Repo menyimpan GRAD_BACKUP_KEEP berkas terakhir dalam SATU commit yang di-force-push,
# supaya ukuran repo tidak tumbuh tiap hari. Cara memulihkan: RESTORE.md di repo backup.
set -euo pipefail

DIR=/home/ubuntu/GITKARA2.1
REPO_DIR=${GRAD_BACKUP_REPO_DIR:-$HOME/grad-backup}
REMOTE=${GRAD_BACKUP_REMOTE:-https://github.com/Rehan30g/grad-backup.git}
PASS_FILE=${GRAD_BACKUP_PASS_FILE:-$HOME/.grad-backup-pass}
KEEP=${GRAD_BACKUP_KEEP:-7}
log() { echo "[$(date -Is)] $*"; }
# Status untuk bot (ai/backup-monitor.js): gagal → owner dikabari lewat DM WhatsApp.
STATUS_FILE=${GRAD_BACKUP_STATUS_FILE:-$DIR/data/logs/backup-status.json}
write_status() {
  mkdir -p "$(dirname "$STATUS_FILE")"
  node -e 'const [file, ok, detail] = process.argv.slice(1); require("fs").writeFileSync(file, JSON.stringify({ ok: ok === "1", at: Date.now(), detail }) + "\n");' "$STATUS_FILE" "$1" "$2"
}
on_error() {
  local detail="baris $1: $2"
  log "GAGAL: $detail"
  write_status 0 "$detail" || true
}
trap 'on_error $LINENO "$BASH_COMMAND"' ERR

[ -s "$PASS_FILE" ] || { log "GAGAL: kata sandi backup ($PASS_FILE) belum ada"; write_status 0 "kata sandi backup tidak ada"; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%MZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/grad"
mkdir -p "$STAGE"
cd "$DIR"

for file in ai-memory.json data.json features.json agent-jobs.json .env data/notebook.json data/runtime-settings.json data/dashboard-token; do
  if [ -e "$file" ]; then mkdir -p "$STAGE/$(dirname "$file")"; cp -a "$file" "$STAGE/$file"; fi
done
for dir in auth data/skills data/stickers; do
  if [ -d "$dir" ]; then mkdir -p "$STAGE/$dir"; cp -a "$dir/." "$STAGE/$dir/"; fi
done
# SQLite stiker disalin konsisten (bot bisa sedang menulis): VACUUM INTO, bukan cp.
if [ -f data/stickers/stickers.db ]; then
  rm -f "$STAGE"/data/stickers/stickers.db*
  node --no-warnings "$DIR/scripts/sqlite-snapshot.js" "$DIR/data/stickers/stickers.db" "$STAGE/data/stickers/stickers.db"
fi
printf 'dibuat %s dari %s\n' "$(date -Is)" "$(hostname)" > "$STAGE/BACKUP-INFO.txt"

mkdir -p "$REPO_DIR/backups"
ARCHIVE="$REPO_DIR/backups/grad-$STAMP.tar.gz.enc"
tar -C "$WORK" -czf - grad | openssl enc -aes-256-cbc -pbkdf2 -iter 300000 -salt -pass "file:$PASS_FILE" -out "$ARCHIVE"
# Uji buka sebelum dikirim: backup yang tidak bisa dibuka lebih buruk dari tidak ada.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -pass "file:$PASS_FILE" -in "$ARCHIVE" | tar -tzf - grad/ai-memory.json >/dev/null
SIZE=$(du -h "$ARCHIVE" | cut -f1)

# Simpan KEEP berkas terbaru saja.
ls -1t "$REPO_DIR"/backups/grad-*.tar.gz.enc | tail -n +"$((KEEP + 1))" | xargs -r rm -f
(cd "$REPO_DIR/backups" && sha256sum grad-*.tar.gz.enc > SHA256SUMS)
cp "$DIR/scripts/backup-RESTORE.md" "$REPO_DIR/RESTORE.md"
# Panduan untuk agent AI (Claude Code, opencode, …) di server baru.
cp "$DIR/scripts/backup-CLAUDE.md" "$REPO_DIR/CLAUDE.md"
cp "$DIR/scripts/backup-AGENTS.md" "$REPO_DIR/AGENTS.md"

cd "$REPO_DIR"
[ -d .git ] || git init -q
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REMOTE"
git checkout -q --orphan snapshot
git add -A
git -c user.name="Grad Backup" -c user.email="backup@grad.local" commit -q -m "Backup $STAMP ($SIZE)"
git branch -D main >/dev/null 2>&1 || true
git branch -m main
git push -q -f origin main
git gc -q --prune=now
COUNT=$(ls -1 backups/grad-*.tar.gz.enc | wc -l)
write_status 1 "grad-$STAMP.tar.gz.enc ($SIZE), $COUNT cadangan"
log "OK: grad-$STAMP.tar.gz.enc ($SIZE), $COUNT cadangan di repo"
