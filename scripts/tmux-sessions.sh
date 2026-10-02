#!/usr/bin/env bash
# Menyalakan sesi tmux `wabot` dan `opencode` bila belum ada. Aman dipanggil berulang.
# Dipasang di crontab `@reboot` karena VM VMware ini bisa mati paksa dari sisi host
# (2 Okt: fs "not properly unmounted", tanpa jejak OOM) dan sesi tmux ikut hilang.
set -u
DIR=/home/ubuntu/GITKARA2.1
LOG_DIR="$DIR/data/logs"
mkdir -p "$LOG_DIR"
export PATH="$HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Tunggu proxy OpenRouter (WARP + privoxy) siap, maks ±60 dtk; bot tetap dinyalakan
# walau proxy belum siap, karena WhatsApp tidak lewat proxy.
for _ in $(seq 1 30); do
  code=$(curl -s -m 5 -x http://127.0.0.1:8118 -o /dev/null -w '%{http_code}' https://openrouter.ai/api/v1/models || true)
  [ "$code" = "200" ] && break
  sleep 2
done

if ! tmux has-session -t wabot 2>/dev/null; then
  # Log disimpan di disk supaya penyebab mati masih bisa dibaca setelah reboot.
  # Heap dibatasi supaya kebocoran memori berakhir crash + restart, bukan VM swap berat.
  tmux new-session -d -s wabot -c "$DIR" "bash -c '
    while true; do
      log=\"$LOG_DIR/wabot.log\"
      [ -f \"\$log\" ] && [ \$(stat -c%s \"\$log\") -gt 20000000 ] && mv \"\$log\" \"\$log.1\"
      echo \"[\$(date -Is)] start node index.js\" >> \"\$log\"
      node --max-old-space-size=1536 index.js 2>&1 | tee -a \"\$log\"
      echo \"[\$(date -Is)] keluar kode \${PIPESTATUS[0]}\" | tee -a \"\$log\"
      sleep 3
    done'"
fi

if ! tmux has-session -t opencode 2>/dev/null; then
  tmux new-session -d -s opencode -c "$DIR" 'export PATH=$HOME/.opencode/bin:$PATH HTTPS_PROXY=http://127.0.0.1:8118 HTTP_PROXY=http://127.0.0.1:8118; opencode'
fi
tmux ls
