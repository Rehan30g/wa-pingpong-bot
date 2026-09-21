# AGENTS.md

Panduan untuk AI agent (dan manusia) yang bekerja di VPS ini.

## VPS

- OS: Ubuntu 22.04, Node.js v20 (NodeSource), user: `ubuntu`
- Project utama: `/home/ubuntu/GITKARA2.1` — bot WhatsApp ping-pong game (Baileys)

## Struktur Project

- `index.js` — kode utama bot
- `auth/` — kredensial sesi WhatsApp. **JANGAN dihapus/di-edit** — kalau hilang, bot harus scan QR ulang
- `data.json` — owner (`owner`), grup yang diizinkan (`allowedGroups`), dan akses pengelola per grup (`vetoAccess`). Edit via command/kode, bukan manual saat bot jalan
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

## Arsitektur AI Grup

- `ai/group-agent.js` mengelola buffer percakapan, keputusan Jev, balasan GLM, reaction, read receipt, presence mengetik, identitas peserta, dan auto-compact.
- Jev (`typesafe/jev-1.13`) hanya memilih tindakan. GLM (`z-ai/glm-5.3-flash`) menulis balasan dan compact memory dengan reasoning `low`.
- Gambar dan video (langsung atau yang dikutip) diunduh sebagai data URL dan dikirim ke GLM sebagai konten multimodal (`image_url`/`video_url`); media aktif terdahulu ikut dikirim ulang hingga batas `AI_HISTORY_MEDIA_LIMIT` (default 4). Media tanpa caption diproses dengan teks `[mengirim gambar]`/`[mengirim video]`. Jev tetap berbasis teks dan hanya menerima sinyal `has_image`/`has_video`. Batas ukuran tiap media diatur `AI_MAX_MEDIA_MB` (default 20 MB).
- Media membawa klasifikasi `kind` (`sticker`/`attachment`) dan `format` (`image`/`video`/`gif`/`webp`). Jev menerima sinyal klasifikasi tersebut. GLM menghasilkan output terstruktur berisi teks dan `reply_to_entry_id`; nilai null berarti kirim bubble standalone, bukan otomatis quote pemicu.
- Pesan cepat memakai debounce per grup. Pesan dalam jendela debounce yang sama digabung (`superseded`), tetapi evaluasi yang sedang berjalan TIDAK dibatalkan pesan baru — pesan baru mengantri dan diproses setelahnya, dan evaluasi antrean yang basi (ada pesan lebih baru) dilewati.
- Read receipt (centang biru) dikirim setelah Jev menghasilkan keputusan untuk pesan itu, termasuk saat keputusannya ignore/ditolak. Pesan yang belum pernah dievaluasi (masih di debounce atau basi/superseded) tetap belum terbaca (centang 1).
- Bot memakai `markOnlineOnConnect` plus heartbeat presence `available` berkala (4 menit) agar status bot selalu tampil online dan receipt delivered aktif: pesan pengguna mendapat centang abu-abu begitu diterima perangkat bot, terlepas dari keputusan Jev.
- Lanjutan percakapan langsung dengan bot (entri riwayat sebelum pesan terbaru berasal dari bot) dianggap diarahkan ke bot untuk threshold reply dan reaction, sehingga balasan tidak hilang hanya karena confidence Jev rendah. Konfirmasi singkat ("iyap", "sip") dalam dialog bot diberi reaction ack, bukan diabaikan; reaction heart tetap khusus apresiasi yang ditujukan ke bot.
- Identitas peserta harus memakai `participantPn`/`senderPn`/alias sebelum `participant`, lalu petakan LID melalui field `jid` pada metadata peserta grup. Riwayat dan state harus menyimpan nomor PN, bukan LID. Nomor sama berarti orang sama; nama sama dengan nomor berbeda berarti orang berbeda.
- Tag/mention di teks WhatsApp berupa nomor (PN atau LID). `decorateMentions` di `index.js` mengubahnya menjadi `@Nama` sebelum masuk riwayat, sehingga tag bot terbaca sebagai `@<BOT_NAME>`, bukan nomor.
- Riwayat aktif dan memori compact berbeda. `/clear` hanya membersihkan riwayat aktif; `/reset` membersihkan keduanya; `/memory` menampilkan konteks GLM, konteks Jev, riwayat aktif, dan timestamp WIT. Ketiganya dapat dipakai owner, admin WhatsApp grup, atau anggota yang diberi akses veto oleh owner (`/veto`, `/unveto`, `/veto list`).
- Auto-compact tidak boleh diumumkan ke grup dan tidak boleh menghidupkan kembali konteks setelah `/clear` atau `/reset`.
- `.env` adalah rahasia dan tidak boleh di-commit. `.env.example` harus selalu memakai placeholder.

## Arsitektur Agen, Memori, dan DM

- `ai/memory-store.js` memegang seluruh `ai-memory.json` (versi 2) dan bermigrasi otomatis dari bentuk lama `{groups}`. Isinya: `groups` (memori per grup), `people` (profil per nomor + memori DM), dan `relationships` (ringkasan hubungan antar orang/grup).
- Saat compact grup, GLM sekaligus mengekstrak `people` dan `relationships`, jadi memori orang/grup/hubungan tumbuh bersama dan Grad terasa satu AI yang mengenal siapa-siapa.
- `ai/direct-agent.js` menangani chat pribadi. Di DM bot membalas lebih sering (default reply) karena chat jelas ditujukan ke bot, tetapi tetap natural: delay + presence mengetik + sesekali memecah balasan.
- **Safety DM (wajib dipertahankan):** `memoryStore.canDirectMessage(phone)` hanya true bila nomor pernah mengirim pesan di grup yang diizinkan. Orang asing yang DM dibiarkan tanpa balasan. Permintaan menyebarkan/mem-forward pesan ke banyak orang ditolak dengan template tetap, dan tidak ada API kirim ke target selain lawan chat.
- `ai/humanize.js` menyediakan delay natural, deteksi jam tenang WIT, pemecahan balasan, deteksi broadcast, deteksi opt-out/opt-in, dan parser reminder sederhana.
- `ai/scheduler.js` menjalankan job persisten di `agent-jobs.json`: `reminder`, `follow_up`, dan `proactive_checkin`. DM proaktif melewati gerbang whitelist, `opt_out`, jam tenang, cooldown per orang, dan kuota harian. Reminder yang diminta pengguna tetap dikirim walau DM proaktif dimatikan.
- Owner mengontrol lewat `/agent status`, `/agent on`, `/agent off`, `/agent clear`.
- `.env` adalah rahasia dan tidak boleh di-commit. `.env.example` harus selalu memakai placeholder.

## Checklist Perubahan AI

1. Jalankan `node --check index.js`, `node --check ai/group-agent.js`, `node --check ai/direct-agent.js`, dan `node --check ai/scheduler.js`.
2. Jalankan `npm test`.
3. Untuk perubahan alur pesan, wajib ada tes yang memanggil `processGroupMessage` langsung dengan mock socket; tes helper saja tidak cukup. Untuk DM, panggil `processDirectMessage` dengan mock socket dan pastikan whitelist/broadcast dijaga.
4. Pastikan parameter yang dipakai saat menyimpan riwayat (`senderId`, `senderName`, `text`, mention/reply) diambil dari object argumen atau dideklarasikan lokal—jangan mengandalkan variabel yang tidak berada dalam scope.
5. Untuk validasi API nyata gunakan `npm run simulate:ai`, `npm run simulate:burst`, `npm run simulate:memory`, atau `npm run simulate:dm`; jangan mencetak API key.

## Env

`~/.bashrc` berisi: PATH opencode (`~/.opencode/bin`), `HTTP_PROXY`/`HTTPS_PROXY` → 8118, alias `oc` (chat lanjut sesi), `ocn` (chat baru), `oct` (TUI).
