# AGENTS.md

Panduan untuk AI agent (dan manusia) yang bekerja di VPS ini.

## VPS

- OS: Ubuntu 22.04, Node.js v20 (NodeSource), user: `ubuntu`
- Project utama: `/home/ubuntu/GITKARA2.1` — bot WhatsApp ping-pong game (Baileys)

## Struktur Project

- `index.js` — kode utama bot
- `auth/` — kredensial sesi WhatsApp. **JANGAN dihapus/di-edit** — kalau hilang, bot harus scan QR ulang
- `data.json` — owner (`owner`) & grup yang diizinkan (`allowedGroups`). Edit via `data = ...` di kode, bukan manual saat bot jalan
- `test/` — unit test, jalankan dengan `npm test`

## Sesi tmux yang Berjalan (run nonstop)

| Sesi | Isi |
|---|---|
| `opencode` | TUI opencode (model default: `openrouter/z-ai/glm-5.3-flash`) |
| `wabot` | Bot WhatsApp: `while true; do node index.js; sleep 3; done` — auto-restart |

Cek status: `tmux ls`
Masuk sesi: `tmux attach -t wabot` / `tmux attach -t opencode` (keluar: `Ctrl+B` lalu `D` — JANGAN `exit`/`Ctrl+D`)

## Restart Bot (cara yang benar)

```bash
tmux send-keys -t wabot C-c
```

Loop tmux akan otomatis menyalakan ulang bot dalam 3 detik. Verifikasi:

```bash
sleep 5 && tmux capture-pane -t wabot -p | tail -5
```

**Hindari perintah `/reboot` via WhatsApp** — bot me-respawn proses detached di luar tmux, sehingga muncul 2 instance bot sekaligus. Kalau sampai terjadi, matikan salah satu: `pkill -f "node index.js"` (loop tmux akan menyalakan ulang satu instance yang benar).

Kalau mau edit kode bot lalu apply:
1. Edit file (mis. `index.js`)
2. `tmux send-keys -t wabot C-c` (restart)
3. Cek log: `tmux capture-pane -t wabot -p`

## Restart Sesi opencode (kalau mati/ke-close)

```bash
tmux kill-session -t opencode 2>/dev/null
tmux new-session -d -s opencode -c /home/ubuntu/GITKARA2.1 'export PATH=$HOME/.opencode/bin:$PATH HTTPS_PROXY=http://127.0.0.1:8118 HTTP_PROXY=http://127.0.0.1:8118; opencode'
```

## PENTING: Proxy Wajib untuk OpenRouter

IP VPS (157.66.55.188) **diblok OpenRouter secara direct (403)**. Semua request ke
`openrouter.ai` HARUS lewat proxy:

- Privoxy (HTTP): `http://127.0.0.1:8118` → forward ke WARP
- WARP (SOCKS5): `socks5://127.0.0.1:40000`

```bash
# curl
curl -x http://127.0.0.1:8118 https://openrouter.ai/api/v1/models

# Node/axios
const agent = new HttpsProxyAgent("http://127.0.0.1:8118");
await axios.get("https://openrouter.ai/api/v1/...", { httpsAgent: agent });
```

Traffic lain (WhatsApp, GitHub, apt) TIDAK perlu proxy — jangan diset untuk itu.

Cek kesehatan:
```bash
warp-cli --accept-tos status          # harus: Connected
systemctl is-active privoxy           # harus: active
curl -s -x http://127.0.0.1:8118 -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/models   # harus: 200
```

Kalau WARP disconnect: `warp-cli --accept-tos connect`

## API Key

- OpenRouter key tersimpan di `~/.local/share/opencode/auth.json` (chmod 600)
- Jangan pernah commit/print key ke log atau chat

## Env

`~/.bashrc` berisi: PATH opencode (`~/.opencode/bin`), `HTTP_PROXY`/`HTTPS_PROXY` → 8118, alias `oc` (chat lanjut sesi), `ocn` (chat baru), `oct` (TUI).
