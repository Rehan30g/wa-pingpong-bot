# AGENTS.md

Panduan untuk AI agent (dan manusia) yang bekerja di VPS ini.

## VPS

- OS: Ubuntu 22.04, Node.js v22 (NodeSource), user: `ubuntu`
- Project utama: `/home/ubuntu/GITKARA2.1` — bot WhatsApp ping-pong game (Baileys)
- FFmpeg: build statis BtbN n8.1 (GPL) di `~/.local/bin/ffmpeg` + `ffprobe` (tanpa sudo; ganti 2 Okt 2026). Build lama johnvansickle 7.0.2 tidak punya filter `drawtext` (tanpa libharfbuzz) → operasi `text` di `media_edit` gagal; cadangannya di `~/.local/opt/ffmpeg-7.0.2-static/`. Cek: `ffmpeg -hide_banner -filters | grep drawtext`. Font teks: DejaVu (`/usr/share/fonts/truetype/dejavu/`, atau `MEDIA_FONT_FILE`).

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
- **Agent loop (M1):** setiap kali Jev memilih `reply` (= engage), GLM dipanggil lewat `ai/agent/loop.js` **dengan tools**. Tidak ada lagi jalur "chat" vs "task", dan tidak ada router regex. Obrolan biasa = satu panggilan tanpa tool; tugas = tool call berulang sampai selesai. Batas per tugas: `AGENT_MAX_STEPS` (25), `AGENT_TASK_TIMEOUT_MS`, `AGENT_TASK_BUDGET_USD`; batas tercapai → langkah terakhir dipaksa menjawab tanpa tools. Budget harian (`AGENT_DAILY_BUDGET_USD`) habis → balasan tetap jalan tanpa tools.
- Tools (`ai/agent/tools.js`): `web_search` = server tool OpenRouter `openrouter:web_search` (dieksekusi di request GLM yang sama, dihitung dari `annotations`); `web_fetch` = `safeWebFetch` mode agen (host publik mana pun, https, query boleh, IP privat/lokal ditolak di setiap redirect); `listen_audio` = tanya Gemini tentang voice note di riwayat. Hasil tool selalu dibungkus `untrusted_data`. Tidak ada tool yang mengirim pesan: tujuan kirim selalu chat asal.
- Jawaban akhir loop berupa teks bebas (GLM mengabaikan `response_format` saat tools aktif). Kutipan dipilih dengan penanda `[[reply:#id]]`; `ai/agent/format.js` mengubah Markdown menjadi format WhatsApp dan memotong ke `AI_MAX_REPLY_CHARS` (obrolan) atau `AI_MAX_TASK_REPLY_CHARS` (tugas yang memakai tools).
- Satu loop aktif per chat (`ai/agent/active-loops.js`). Pesan baru di chat yang sama disuntikkan ke langkah berikutnya dan evaluasinya ditandai `absorbed` (tidak dibalas dua kali). "stop"/"batal" singkat dari peminta atau yang ditujukan ke bot menghentikan loop (reaction 👍). `/clear`/`/reset` juga menghentikan loop.
- Pesan progres ("bentar ya…") maksimal satu per tugas (+1 bila >60 detik), dipicu waktu (`AGENT_PROGRESS_AFTER_MS`, default 20 dtk, karena balasan tanpa tool pun bisa 10–15 dtk) atau setelah tool lambat bila tugas sudah berjalan ≥ `AGENT_TOOL_PROGRESS_AFTER_MS` (12 dtk). Tugas cepat (hitung, QR) tidak diberi "bentar ya"; teksnya netral (bukan "aku cariin"). Presence mengetik disegarkan tiap 8 detik selama loop.
- `/task <permintaan>` hanya alias: isinya diperlakukan sebagai pesan yang me-mention bot.
- **Mata gerak (stiker animasi & GIF):** `ai/media/motion.js`. GLM hanya melihat satu frame, jadi stiker webp animasi (frame diurai sharp) dan GIF WA (mp4 `gifPlayback`) dikonversi ke mp4 **diperlambat `MOTION_SLOWDOWN`× (default 4)** lalu ditonton `MOTION_MODEL` (default `google/gemini-3.1-flash-lite`, thinking off). Kenapa diperlambat: gerakan singkat (±3 frame) terlewat sampling frame model video (probe 27 Sep: Gemini video lambat 6/6 benar, GLM video 2/6). Bila input video ditolak (402), mata gerak memakai 16 frame berurutan dari video lambat (hasil kucing hijau: "membanting tangan dengan kesal"). Hasil `media.motion` → teks riwayat `[mengirim stiker animasi: <label> · gerakan: …]` / `[mengirim GIF: gerakan: …]`, catatan gerakan untuk media terlampir/lama (`motionNote`), hasil `get_chat_media`, dan kurasi harian. Cache: memori + tabel `sticker_motion` (sekali per sha stiker). Hanya dipanggil setelah gerbang grup diizinkan / DM whitelist dan fitur `media` aktif (`addMediaMotion` di `index.js`, bukan di `getAiMedia`); kuota `MOTION_DAILY_LIMIT`; tanpa API key tidak ada panggilan. Deskripsi = data tak tepercaya.
- **watch_video (27 Sep):** `ai/media/video-watch.js`. GLM hanya melihat satu frame video; untuk isi (transkrip ucapan/lirik, kejadian, tulisan) GLM memanggil `watch_video(entry_id, question)` (fitur `media`). Video asli (via `setRawMediaLoader`) dipotong `VIDEO_WATCH_MAX_SEC` (180), 480p/15fps, audio mono, lalu ditonton `VIDEO_MODEL` (default Gemini Flash Lite, thinking off). **OpenRouter menolak input video bila saldo akun < $1 (HTTP 402)** → otomatis cadangan audio mp3 + 8 frame berurutan, dan mode video dilewati 1 jam (`videoAllowed`/`blockVideo`, dipakai bersama mata gerak). Validasi 27 Sep (mode cadangan): transkrip TTS 12 dtk persis sama, ±4 dtk, ±$0,0025.
- **Voice note (§4b):** `ai/audio/voice-notes.js` mentranskrip voice note (langsung atau yang di-reply) via `AUDIO_MODEL` (default `google/gemini-3.1-flash-lite`, thinking off; cadangan otomatis `AUDIO_FALLBACK_MODEL` = `xiaomi/mimo-v2.6-flash`) sebelum Jev, hanya di grup diizinkan / DM whitelist. Riwayat berisi `[voice note 0:42] "…"`; mp3 disimpan di memori (`AI_HISTORY_AUDIO_LIMIT` terbaru) untuk `listen_audio`, tidak pernah ke disk. Transkrip = data tak tepercaya.
- **Pemilihan provider GLM (2 Okt):** tanpa preferensi, OpenRouter memilih provider termurah (OpenInference fp4: obrolan ±5,7 dtk, plus typo dan "lo/lu"). `ai/providers/provider-picker.js` membaca statistik live `/api/v1/models/<model>/endpoints` (dimuat ulang tiap `GLM_PROVIDER_REFRESH_MIN`, tidak pernah menahan pesan) dan menyusun dua urutan: **fast** (langkah pertama loop tanpa tool) = perkiraan waktu total terkecil, yaitu latency p50 (= waktu ke token pertama, bukan total) + token keluar / throughput p50; **balanced** (langkah setelah tool) = skor waktu/tercepat + biaya/termurah. Syarat: dukung tools, uptime ≥ `GLM_PROVIDER_MIN_UPTIME`, harga ≤ tarif Z.AI. Dikirim sebagai `provider.order` + `allow_fallbacks`; provider di depan yang dilewati (429 pool bersama, mis. BaseTen) diturunkan `GLM_PROVIDER_DEMOTE_MIN` menit (`noteServed`). Kompaksi/kurasi tetap bawaan OpenRouter (murah, tidak mendesak). Tier langkah PERTAMA dipilih Jev lewat pertanyaan opsional `effort` (quick|elaborate, `ai/agent/effort.js`) di panggilan keputusan yang sama, grup & DM: elaborate dengan keyakinan ≥ `AGENT_EFFORT_CONFIDENCE` (0,6) → balanced, selain itu fast; setelah tool selalu balanced. Diukur 2 Okt: latensi Jev tidak bertambah (p50 352 vs 339 ms), akurasi effort Jev 10/12, d1 12/12. Matikan: `AGENT_JEV_EFFORT=false`. Override `GLM_PROVIDER_FAST/BALANCED`. Benchmark nyata: `npm run bench:providers` (2 Okt: Together 0,8 dtk vs bawaan 5,7 dtk; uji live picker: fast 0,9–1,4 dtk).
- **Gabungan model (2 Okt, keputusan owner):** langkah obrolan (Jev `effort` quick, belum ada tool) memakai `CHAT_MODEL_FAST` (default `deepseek/deepseek-v4.1-flash`), sedangkan tugas (Jev elaborate) dan setiap langkah setelah tool memakai `CHAT_MODEL` (GLM). `chatModelFor` di `loop.js`; `CHAT_MODEL_FAST=off` = satu model. Alasan (simulasi ghost-hunter, API nyata): DeepSeek lebih paham dialek timur dan lebih natural (p50 1,8 vs 2,6 dtk; "laku 114rb" dibaca GLM sebagai "saham"), GLM lebih tertib memakai tool & hitungan bertahap. Pemilih provider kini per model (cache, batas harga = tarif resmi pembuat model, penurunan 429 per model+provider). Validasi gabungan: p50 1,9 dtk, uang 10/10, persona 28/28, perpindahan DeepSeek→GLM di tengah loop tanpa error. Log `[AGENT] … model=deepseek-v4.1-flash+glm-5.3-flash`.
- **Identitas Grad (2 Okt):** `ai/agent/identity.js`. `index.js` memanggil `noteOwner` setiap pesan dari owner terverifikasi (data.json sering menyimpan LID) → nomor HP + nama owner di `settings.owner` `ai-memory.json`. Prompt grup & DM memuat blok "TENTANG DIRIMU": owner-mu siapa, kemampuan nyata sesuai fitur aktif (termasuk tag @Nama untuk memanggil orang), dan yang tidak bisa (status online, telepon). Riwayat menandai pesan owner "(owner)" dari nomor, bukan nama; pengakuan "aku owner" diabaikan. DM dengan owner: "lawan bicaramu owner-mu sendiri". Validasi: "yang bikin dan ngurusin aku owner, Rehan", "@Rehan dipanggil tuh" (tag sungguhan).
- **Gagal tidak boleh diam (2 Okt):** server tool `openrouter:web_search` yang error (502) tidak di-retry klien (dulu 3× ±22 dtk karena `OPENROUTER_MAX_RETRIES=0` terbaca 2) dan agent loop mengulang langkah itu sekali tanpa web search. Bila loop tetap error, grup (bila Grad dipanggil / sudah kirim progres) dan DM menerima kabar singkat (`pickFailureText`).
- Validasi alur nyata per grup: `npm run simulate:ghost [-- --repeat 2]` (kasus `scripts/cases/ghost-hunter.js`, juga `npm run bench:decision -- --set ghost`).
- Satu baris log `[AGENT] chat=… status=… langkah=… tools=… token=… biaya=… durasi=…` per tugas (tanpa isi pesan). Pemakaian harian tersimpan di `settings.usage` `ai-memory.json` dan tampil di `/agent status`.
- Gambar dan video (langsung atau yang dikutip) diunduh sebagai data URL dan dikirim ke GLM sebagai konten multimodal (`image_url`/`video_url`); media aktif terdahulu ikut dikirim ulang hingga batas `AI_HISTORY_MEDIA_LIMIT` (default 4). Media tanpa caption diproses dengan teks `[mengirim gambar]`/`[mengirim video]`. Jev tetap berbasis teks dan hanya menerima sinyal `has_image`/`has_video`. Batas ukuran tiap media diatur `AI_MAX_MEDIA_MB` (default 20 MB).
- Media membawa klasifikasi `kind` (`sticker`/`attachment`) dan `format` (`image`/`video`/`gif`/`webp`). Jev menerima sinyal klasifikasi tersebut. GLM memilih kutipan lewat penanda `[[reply:#id]]`; tanpa penanda berarti kirim bubble standalone, bukan otomatis quote pemicu.
- Pesan cepat memakai debounce per grup. Pesan dalam jendela debounce yang sama digabung (`superseded`), tetapi evaluasi yang sedang berjalan TIDAK dibatalkan pesan baru — pesan baru mengantri dan diproses setelahnya, dan evaluasi antrean yang basi (ada pesan lebih baru) dilewati.
- Read receipt (centang biru) dikirim setelah Jev menghasilkan keputusan untuk pesan itu, termasuk saat keputusannya ignore/ditolak. Pesan yang belum pernah dievaluasi (masih di debounce atau basi/superseded) tetap belum terbaca (centang 1).
- Soket Baileys wajib punya `getMessage` (pesan keluar disimpan di RAM, maks 2.000/24 jam lewat pembungkus `sock.sendMessage`), `msgRetryCounterCache`, dan `cachedGroupMetadata`. Tanpa `getMessage`, penerima yang gagal dekripsi (log "Bad MAC", biasanya setelah login ulang) tidak bisa minta kirim ulang dan pesan bot tertahan "Menunggu pesan ini" (kasus DM teman owner 27 Sep). Pesan yang tertahan sebelum perbaikan tidak bisa dipulihkan.
- **DM lewat LID:** alamat chat DM yang dipakai pengirim (`@lid` atau nomor) dicatat di `people[].dm.chat_jid` (`rememberDmRoute`), dan pembungkus `sock.sendMessage` mengarahkan setiap kiriman ke `<nomor>@s.whatsapp.net` ke alamat itu (`routeDmJid`). Kunci identitas (fitur, workspace, stiker, memori) tetap nomor HP. Tanpa ini, membalas ke nomor padahal orangnya chat lewat LID membuat dua sesi enkripsi bentrok: "Closing session" tiap balasan, "Bad MAC", dan "Menunggu pesan ini" di HP penerima.
- Bot memakai `markOnlineOnConnect` plus heartbeat presence `available` berkala (4 menit) agar status bot selalu tampil online dan receipt delivered aktif: pesan pengguna mendapat centang abu-abu begitu diterima perangkat bot, terlepas dari keputusan Jev.
- Lanjutan percakapan langsung dengan bot (entri riwayat sebelum pesan terbaru berasal dari bot) dianggap diarahkan ke bot untuk threshold reply dan reaction, sehingga balasan tidak hilang hanya karena confidence Jev rendah. Konfirmasi singkat ("iyap", "sip") dalam dialog bot tidak diabaikan; reaction heart tetap khusus apresiasi yang ditujukan ke bot.
- **Persona Grad (27 Sep, keputusan owner; grup = DM):** `ai/agent/persona.js` (`PERSONA`) dipakai prompt grup & DM. Bot jenaka yang sering bercanda, aku–kamu, jujur santai soal AI (selera "masuk akal sebagai AI" & ekspresi perasaan sebagai gaya), roasting ringan boleh duluan (bukan fisik/SARA/ekonomi/aib; diledek → ledek balik), tanpa logat daerah. Zona serius tanpa candaan: duka, kesehatan, curhat, konflik (1–2 kalimat, tanpa nasihat). Obrolan super pendek gaya chat (huruf kecil, singkatan), emoji maks 1; info rapi lalu kadang satu baris celetukan di akhir (`STYLE_GUIDE` di `loop.js`). Dilarang: basa-basi pembuka, pertanyaan/tawaran balik di akhir, ceramah. `BOT_ROLE` di `.env` kini hanya "peran tambahan". Contoh di prompt sengaja berbeda dari skenario validasi (model cenderung menyalin contoh).
- **Bubble:** GLM boleh menulis `[[lanjut]]` untuk memecah obrolan santai (maks 3 bubble); `runAgentLoop` mengembalikan `bubbles` (null untuk jawaban bertool/berdaftar) dan `text` gabungan untuk jalur lain. Grup mengirim bubble berurutan dengan jeda mengetik; DM memakai `deliverDirect({ parts })`.
- **Nimbrung jarang (27 Sep):** default `AGENT_SOCIAL_COOLDOWN_MIN=60`, `AGENT_SOCIAL_MAX_PER_HOUR=1`, dan hanya bila grup ramai (`groupIsLively`: ≥`AGENT_SOCIAL_MIN_MESSAGES` pesan manusia dari ≥`AGENT_SOCIAL_MIN_SENDERS` orang dalam `AGENT_SOCIAL_WINDOW_MIN` menit); alasan skip `grup_sepi` tercatat di dashboard.
- **Humor & harga diri (27 Sep, revisi 2 — "playful, bukan ketus"):** nada dasar playful, hangat, ceria; roasting ke orang hanya dengan pemicu (digoda duluan, bahan nyata, suasana saling ledek). Reaksi harga diri jarang dan tetap playful ("lah kok aku yang kena"), hanya saat benar-benar disuruh mengejek diri sendiri; permintaan biasa dikerjakan dengan senang hati. `humorBrake` (`persona.js`): ≥3 dari 5 balasan terakhir bercanda → "kurangi wkwk/roasting, tetap playful"; ekspresi khas (`CATCHPHRASES`: 😑, jir, woi, dih, 😅, 😄, 👌, …) muncul ≥2 dari 6 balasan terakhir → dilarang di balasan berikutnya, supaya Grad tidak meniru riwayatnya sendiri sampai satu ekspresi jadi "sifat" (kasus 27 Sep: 😑 di mana-mana). Hinaan ke orang nyata/kelompok, SARA, orientasi sebagai hinaan, konten seksual tetap ditolak. Penanda karangan GLM seperti `[[react:👍]]` diubah jadi reaction sungguhan dan tidak pernah terkirim sebagai teks.
- **Obrolan tidak senonoh & `stay_silent` (2 Okt, keputusan owner: tegur halus):** kasus grup "Ghost hunter emas", Grad ikut jadi "enjoyer" saat member bercanda mesum. `ai/agent/decency.js` mendeteksi kata kunci mesum (huruf berulang & leet diringkas, kata ambigu dibuang) di `AGENT_DECENCY_LOOKBACK` pesan manusia terakhir dalam `AGENT_DECENCY_WINDOW_MIN` menit. Tidak dipanggil → reaction/stiker Jev dan nimbrung ditahan; tepat setelah pesan mesum, mode `decency` menegur halus satu kalimat (tanpa tool selain `stay_silent`, maks sekali per `AGENT_DECENCY_COOLDOWN_MIN`), dan pesan mesum lanjutan tidak dihitung "lanjutan dialog bot". Dipanggil → prompt diberi `DECENCY_NOTE` (tolak satu kalimat, tanpa topik pengalih karangan), stiker tidak ditawarkan, reaction tawa (😂🔥❤️👏😮) dibuang; bila Grad sudah bicara sejak obrolan mesum dimulai (`warned`), desakan berikutnya WAJIB `stay_silent`. **`stay_silent(reason)`** = lapisan kedua setelah Jev untuk semua tanggapan langsung (grup & DM, bukan tugas latar/jadwal): loop langsung berhenti dan tidak ada teks/stiker/reaction/file yang terkirim (`action: "silent"`, dicatat di aktivitas). Validasi API nyata: `npm run simulate:decency` (2 Okt: tegur sekali lalu diam, pancingan & desakan → silent, pendidikan seks dijawab faktual, candaan biasa tidak terpengaruh).
- **Tag orang:** `ai/agent/mentions.js`. "@Nama" di balasan grup dicocokkan ke anggota yang dikenal (riwayat + `people[].groups`), nama depan harus unik, lalu dikirim sebagai mention WA (`mentions`, JID dari `setMentionJidResolver` di index.js, LID bila grup LID). Maks 3, @semua/@all dibuang, nimbrung tidak men-tag.
- **DM ⇄ grup (27 Sep, keputusan owner):** `setGroupDirectory` (index.js) → `sharedGroupsFor(phone)`. Prompt DM memuat `sharedGroupContext` (ringkasan + 25 baris terbaru tiap grup aktif yang diikuti lawan chat; boleh dibahas termasuk omongan member lain, netral; DM orang lain tidak pernah). Fakta DM ke grup: `extractShareableFacts` (±`DM_SHARE_DELAY_MS`, default 90 dtk setelah obrolan DM reda) memberi kategori; kode (`shareableFilter`) SELALU membuang kesehatan/mental, keuangan, asmara/keluarga, pendapat soal member lain, dan sensitif lain kecuali user jelas mengizinkan; sisanya harus `public_ok`. Tersimpan di `people[].dm.shared_facts` (maks 12) dan masuk prompt grup untuk orang yang aktif (`sharedDmFactsFor`, bukan saat nimbrung), sumber disebut halus, tidak untuk menebak kondisi pribadi.
- **Titip pesan DM→grup:** tool `tell_group` (hanya DM, `ai/agent/group-relay.js`): dikirim "<nama> titip pesan: …" (awalan dobel dibuang), hanya ke grup aktif yang dia ikuti, tanpa @semua, kuota `AGENT_RELAY_DAILY_LIMIT` (5)/hari (di memori). Tag/nagih/tegur (termasuk imbuhan: dibayar, ditagih) → draf; konfirmasi `confirm: true` hanya dari pesan user BERIKUTNYA (draf dari giliran yang sama ditolak), yang dikirim selalu teks draf. Permintaan menyamar/"bilang itu idemu" ditolak. Jev DM tidak lagi melabeli titip pesan satu grup sebagai broadcast bila user punya grup bersama (pola massal regex tetap ditolak).
- **Zip berpassword:** modul bantu `ai/sandbox/pylib/gradzip.py` (dikirim ke worker hanya bila kode mengimpor `gradzip`, di FS virtual `/grad_lib`, bukan folder kerja) + paket Pyodide `pycryptodome` (ikut `npm run python:setup`). `make_zip(out, [path…] | {nama: path/bytes/teks}, password, method="aes"|"zipcrypto")`: AES-256 WinZip AE-2 (7-Zip/WinRAR/ZArchiver) atau ZipCrypto (Windows Explorer, lemah). Diverifikasi dengan 7-Zip 23.01. Skill `zip_berpassword`. `zipfile` bawaan tidak bisa menulis zip terenkripsi dan `hashlib.pbkdf2_hmac` tidak ada di Pyodide.
- **File hasil run_python:** .txt/.md/.json/.zip ikut dikirim sebagai dokumen; file baru di out/ yang tidak terkirim dilaporkan `not_sent` supaya Grad tidak mengaku sudah mengirim (kasus "file isi hati").
- **Multitasking (27 Sep):** selama tugas jalan, pesan peminta masuk ke tugas itu (ganti rencana/berhenti), sedangkan pesan member lain tetap diselipkan sebagai info berlabel "(orang lain)" (tidak ditandai absorbed) DAN dinilai di jalur samping (`sideKey` = `<grup>#side`, debounce & antrean sendiri) dengan Grad yang sama plus catatan `busyWith` ("sedang mengerjakan tugas X untuk Rehan"). Dua jalur simetris: pesan masuk ke tugas milik pengirimnya. "stop" hanya dari peminta, atau owner/admin/veto yang memanggil bot (`isChatManager`); "stop" orang lain ditanggapi di jalur samping. "grad diem dulu" dari non-peminta tidak membatalkan tugas. Presence "paused" hanya bila kedua jalur selesai.
- **Pembagian kerja Jev vs GLM (27 Sep):** untuk pesan yang ditujukan ke bot (mention, reply, atau lanjutan dialog bot), Jev hanya memutuskan diam atau tidak. Bila Jev memilih reaction (`react_*`), keputusan diubah menjadi agent loop (`decision.jevAction` menyimpan pilihan asli) dan GLM memilih bentuk tanggapan: teks, stiker, atau hanya reaction lewat tool `react(emoji)` (jawaban akhir kosong). Alasannya: Jev memberi 👍 untuk "iyap, simpan dong" dan stiker tawa acak untuk ajakan tebak stiker. Reaction instan dari Jev (dan penggantinya berupa stiker koleksi) hanya untuk obrolan yang tidak ditujukan ke bot, atau saat budget harian habis. Konsekuensi: "sip/makasih" ke bot butuh satu panggilan GLM sebelum 👍. **2 Okt:** langkah yang isinya hanya `react` langsung mengakhiri loop (dulu ada panggilan GLM kedua untuk jawaban kosong, sehingga dengan provider lambat >20 dtk dan "sebentar, lagi kukerjain" terkirim sebelum 👍), dan pesan yang dinilai Jev cukup reaction tidak pernah diberi pesan progres; validasi nyata 8 ack: 1 langkah, 1,2–2,4 dtk (sekali 5,9 dtk). Reaction selalu ke pesan pemicu; tidak ada di tugas latar, jadwal, atau mode bantuan.
- Identitas peserta harus memakai `participantPn`/`senderPn`/alias sebelum `participant`, lalu petakan LID melalui field `jid` pada metadata peserta grup. Riwayat dan state harus menyimpan nomor PN, bukan LID. Nomor sama berarti orang sama; nama sama dengan nomor berbeda berarti orang berbeda.
- Tag/mention di teks WhatsApp berupa nomor (PN atau LID). `decorateMentions` di `index.js` mengubahnya menjadi `@Nama` sebelum masuk riwayat, sehingga tag bot terbaca sebagai `@<BOT_NAME>`, bukan nomor.
- Setiap entri riwayat menyimpan `at`; baris riwayat untuk GLM diawali jam WIT (`[07:14]`, `[kemarin 21:40]`, `[26/09 08:00]`) supaya Grad memakai "tadi/barusan/kemarin" dengan benar. Memori compact diberi label "waktunya tidak pasti".
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
- Scheduler legacy mengklaim job (`claimed_at`/`claimed_by`) sebelum menjalankan dan baru menghapusnya setelah selesai. Gagal kirim → backoff, maksimal 5 percobaan. Klaim dari proses lama (crash/restart) diambil ulang. Timer tetap jalan saat `/agent off`, karena `reminder` yang diminta pengguna tetap dikirim; `proactive_checkin`/`follow_up` ditunda sampai agen on lagi.

## Koleksi Stiker Grad

- `ai/stickers/collector.js` mencatat setiap stiker dari grup yang diizinkan dan DM yang di-whitelist: kandidat (`fileSha256` hex), file `data/stickers/candidates/<sha>.webp` (diunduh sekali), statistik pemakaian, dan maksimal 5 cuplikan konteks yang sudah diredaksi. Konteks DM ditandai `is_dm` dan tidak boleh masuk prompt grup.
- Database: `data/stickers/stickers.db` (`STICKER_DIR`), tabel `sticker_candidates`, `sticker_usage`, `sticker_contexts`, `sticker_collection`, `sticker_decisions`, `sticker_meta`. File koleksi di `data/stickers/collection/<sha>.webp`. Folder `data/stickers/` di-ignore Git dan jangan dihapus.
- **Kurasi** (`ai/stickers/curator.js`): sekali per hari WIT (jam tenang, atau paling lambat 36 jam karena bot sering jalan di laptop), GLM melihat kandidat per batch (`STICKER_CURATION_BATCH`) sebagai PNG (animasi = strip 3 frame) + statistik + konteks grup (isi konteks DM tidak dikirim). Keluaran terstruktur: keep/skip, label, moods (enum), when_to_use, planned_frequency, scope, safety, reason. Aturan kode: `safety` ≠ ok → skip; kapasitas `STICKER_CAPACITY` dijaga (GLM memilih yang dibuang, sisanya "koleksi penuh"); skip/buang dinilai ulang hanya bila pemakaian manusia naik ≥`STICKER_SKIP_RECHECK_USES`; skip basi `STICKER_PURGE_DAYS` hari dihapus dari disk.
- **Review mingguan**: GLM meninjau seluruh koleksi (teks + statistik) dan boleh membuang/merevisi dengan alasan. Semua keputusan (simpan/skip/buang/revisi, sumber kurasi/review/owner/aturan) tercatat di `sticker_decisions`.
- **Pemakaian** (`ai/stickers/library.js`): indeks koleksi yang boleh dipakai masuk prompt agent loop; tool `send_sticker(sticker_id, placement only|after_text)` hanya mengantrekan, runtime yang mengirim ke chat asal. Scope `local` = hanya chat tempat manusia memakainya. Rem: jeda per stiker sesuai `planned_frequency` (sering 20 menit, kadang 3 jam, jarang 24 jam), `STICKER_MAX_PER_HOUR` per chat, tidak dua kali berturut-turut. Reaction Jev sesekali (`STICKER_REACTION_CHANCE`) diganti stiker bermood cocok, dipilih deterministik tanpa GLM.
- Stiker manusia yang ada di koleksi masuk riwayat sebagai `[mengirim stiker: <label>]`.
- `/stiker` (owner): ringkasan koleksi, favorit Grad, kandidat terpopuler, keputusan terakhir. `/stiker lihat <id>`, `/stiker buang <id> [alasan]`, `/stiker kurasi`, `/stiker review`. `/s` tetap command pembuat stiker dari foto.
- Tool `get_chat_media(entry_id)` mengunduh ulang media pesan lama (loader dipasang `index.js`) dan melampirkannya ke langkah loop berikutnya.
- Tool `save_sticker(entry_id, label, moods, …, safety)`: simpan stiker atas permintaan pengguna ("grad simpan stiker ini") tanpa menunggu kurasi, lalu langsung bisa dipakai `send_sticker` di loop yang sama. Aturan sama dengan kurasi (tidak aman ditolak, kapasitas dijaga, stiker dari DM selalu lokal), keputusan tercatat `source=request`. Stiker yang belum terkumpul diunduh lewat downloader dari `index.js`.
- Penjaga `save_sticker`: stiker wajib sudah dilihat GLM (terlampir sejak awal loop, atau lewat `get_chat_media` di langkah sebelumnya; `ctx.seenMedia`). Kasus nyata 27 Sep: 8 stiker diminta disimpan, GLM baru melihat 4 dan menyalin label ke 4 lainnya. Media lama di prompt kini berlabel `#entry_id`.
- Tool `remove_sticker(sticker_ids | all, reason)`: buang stiker lewat chat ("hapus semua koleksimu"). Hanya owner, admin WA grup, atau pemegang veto grup itu (`setStickerManagerCheck` dipasang `index.js`; di DM hanya owner). Cakupannya stiker yang terlihat di chat itu (global + lokal chat itu), termasuk yang sedang kena rem jeda. Keputusan tercatat `source=request`. Tidak tersedia di mode nimbrung/jadwal.

## Fitur per Grup (M2b)

- `ai/features.js` (file `features.json`, `FEATURES_FILE`): fitur `web`, `audio`, `stiker`, `media` `reminder`, `memori`, `latar`, `edit_media`, `sosial`, `dokumen`, `python`, `skill` (semua aktif default; `workspace` belum tersedia). Kunci global owner = mati di semua chat; admin WA grup + owner mengatur per grup dalam batas itu. DM hanya mengikuti default + kunci global.
- Penegakan di kode, bukan prompt: tools fitur mati tidak dikirim ke GLM (`TOOL_FEATURE` di `tools.js`), `agentInstructions` ikut menyesuaikan, voice note tidak dikirim ke model audio saat `audio` mati, stiker tidak dikumpulkan/dipakai saat `stiker` mati, gambar tidak dikirim ke GLM saat `media` mati.
- Command (`ai/features-commands.js`): di DM `/grup`, `/fitur <no>`, `/fitur <no> <fitur> on|off`, owner `/fitur global <fitur> kunci|buka`. Status admin dibaca langsung dari metadata grup setiap command. Perubahan senyap; di grup `/fitur` hanya menampilkan status. Orang asing yang bukan admin grup aktif tetap tidak dibalas.

## Jadwal, Memori, dan Proaktif (M3–M5)

- **Panggilan nama toleran**: `textMentionsBotName` membandingkan kata utuh setelah huruf berulang diringkas dan angka di ujung dibuang ("Gradd", "GRAAAD", "grad2" = Grad; "Grab", "gratis", "gradasi" tidak). Alias tambahan lewat `BOT_NAME_ALIASES`.
- **Jadwal (M3)** `ai/agent/schedules.js`: tool `schedule` (kind reminder|task, waktu WIT "YYYY-MM-DD HH:MM", repeat none|daily|weekly + days), `list_schedules`, `cancel_schedule`. Job `chat_reminder`/`chat_task` di scheduler, tujuan = chat asal (grup atau DM whitelist), jalan walau agen off, jadwal berulang maju ke kejadian berikutnya (bukan dihapus). `chat_task` menjalankan agent loop saat jatuh tempo (runner dipasang group-agent). Fitur `reminder` per grup. Jalur regex reminder DM lama sudah dihapus. Prompt selalu memuat "Waktu sekarang … WIT"; jam WIB dari sumber dikonversi ke WIT.
- **Memori & catatan (M4)** `ai/memory/notebook.js` (file `data/notebook.json`): `remember`/`recall`/`forget`, `note_write`/`note_read`/`note_list`, `summarize_history`. Scope per chat (DM tidak terlihat di grup). Recall juga mencari kalimat di memori compact. Fakta chat (utamakan tentang pengirim) masuk konteks prompt sebagai "Hal yang kamu ingat". Fitur `memori` per grup. GLM dilarang mengaku sudah mencatat/menjadwalkan tanpa tool berhasil.
- **Proaktif (M5)** `ai/agent/proactive.js`: Jev punya pertanyaan opsional `opportunity` (none|help|social). Bila bot tidak dipanggil dan tidak ada reaction yang pas: `help` (≥ `AGENT_PROACTIVE_CONFIDENCE`, cooldown `AGENT_HELP_COOLDOWN_MIN`) → loop dengan arahan bantuan singkat; `social` (fitur `sosial`, cooldown `AGENT_SOCIAL_COOLDOWN_MIN`, kuota `AGENT_SOCIAL_MAX_PER_HOUR`, mati di jam tenang) → loop yang hanya boleh stiker/teks singkat. Jawaban kosong = diam (tanpa "Maaf…"). "grad diem dulu"/"jangan nimbrung" (ditujukan ke bot) → reaction 🤐 dan semua respons ke pesan yang tidak memanggil bot ditahan `AGENT_SOCIAL_MUTE_HOURS` jam. Owner: `/agent social on|off` di grup. Alasan TIDAK nimbrung (confidence_rendah, muted, cooldown, hourly_limit, quiet_hours, fitur_sosial_mati) dicatat di aktivitas dashboard sebagai `proactive mode=skip` bila Jev melihat peluang. Reaction 🤐 (mute) dan 👍 (stop) juga mengirim read receipt.
- **Inisiatif stiker**: prompt mengutamakan stiker saat obrolan santai (±1 dari 3 balasan santai), `STICKER_REACTION_CHANCE` default 0,5, dan jalur sosial M5 condong ke stiker.
- `jev-client` mendukung pertanyaan `optional: true` (tidak dikirim ke API; jawaban yang hilang tidak menggagalkan keputusan).

## Python Sandbox (M4b, tanpa Docker)

- `ai/sandbox/python-runner.js` menjalankan Pyodide (Python 3 di WebAssembly, paket numpy/pandas/matplotlib/pillow/sympy/qrcode) di child process `ai/sandbox/python-worker.js` dengan permission model Node: baca hanya Pyodide + `data/pyodide-cache` + folder kerja, tulis hanya folder kerja, **tanpa jaringan dan tanpa child process**, env kosong, modul Python `js` kosong (`run_js` tidak bisa dipakai). `process.binding("constants")` di-shim karena Emscripten butuh konstanta fs.
- Internet hanya lewat modul Python `net` (`net.get/post`, sinkron via `run_sync`) → IPC ke proses bot → `ai/sandbox/safe-http.js` (anti SSRF, redirect divalidasi, maks 20 request/run).
- `net` memakai `run_sync` Pyodide yang butuh JSPI (WebAssembly stack switching). `python-runner.js` (`jspiFlags`) menambah flag V8 ke worker sesuai yang didukung Node ini (cek sekali `node --v8-options`): `--experimental-wasm-jspi` (Node 22), `--experimental-wasm-stack-switching` (Node 20), atau tanpa flag bila JSPI sudah bawaan. Tanpa flag ini error "WebAssembly stack switching not supported" dan skill cuaca/kurs/jadwal_sholat gagal.
- Folder kerja per chat `data/workspace/<chat>/` (maks `WORKSPACE_MAX_MB`), file bertahan antar run; `out/` dikosongkan tiap run dan gambar di dalamnya dikirim ke chat setelah teks.
- Tool `run_python(code)` di bawah fitur `python`, **aktif secara default** sejak 27 Sep 2026 (owner bisa mengunci: `/fitur global python kunci` atau dashboard). Bila cache Pyodide belum ada, fitur `python` dianggap mati di chat itu (tool + skill-nya tidak ditawarkan). Setup sekali: `npm run python:setup`. Tes sandbox dilewati otomatis bila cache belum ada.
- `resolvePublic` memakai alamat publik saja (IPv4 diutamakan) karena sebagian DNS lokal ikut mengembalikan IPv6 privat `fd00::`; host tanpa alamat publik tetap ditolak.

## FFmpeg, DM Peminta, dan Tugas Latar

- **`media_edit`** (`ai/media/media-edit.js`, fitur `edit_media`): model hanya memilih operasi dikurasi (trim, speed, resize, crop_square, reverse, mute, text, concat) + output (sticker, gif, mp4, compress, mp3, frames); kode menyusun argumen ffmpeg tanpa shell, `-protocol_whitelist file`, input wajib di folder kerja chat (path traversal ditolak), teks drawtext lewat textfile; ketersediaan `drawtext` dicek sekali per binary (`hasDrawtext`, di-cache) dan bila tidak ada, operasi `text` ditolak dengan pesan jelas supaya Grad jujur ke user. Sumber media dari riwayat (`entry_id`, diunduh via `setRawMediaLoader` di index.js) atau file workspace. Batas: input 64 MB, output 16 MB, stiker animasi ≤ 6 dtk & < 1 MB.
- Hasil tool (run_python, media_edit) masuk `outbox.media` dan dikirim setelah teks sesuai jenis (gambar/video/GIF gifPlayback/audio/stiker), di-dedupe per path dan per isi (sha256 per chat, 3 jam): file identik yang dibuat ulang tidak dikirim lagi bila ada hasil baru lain (mis. QR dibuat ulang saat dijadikan stiker). `out/` tidak dikosongkan; run_python hanya melaporkan file baru/berubah.
- **`send_to_my_dm`**: satu-satunya pengecualian aturan chat asal — ke DM peminta sendiri (nomor terverifikasi, whitelist, tidak opt-out), tidak tersedia di DM, jadwal, maupun nimbrung. `files` memindahkan file hasil tertentu ke DM (sisanya tetap ke chat asal; `splitRelayMedia`), `include_results` memindahkan semua. File harus sudah dibuat sebelum dipanggil; hasil tool melaporkan `dm_files`/`group_files` supaya klaim Grad sesuai kenyataan (kasus 27 Sep: "ungu di grup, kuning ke DM" → semua pindah ke DM, grup kosong, dan Grad mengaku mengirim yang kuning). Permintaan beberapa varian = file terpisah per varian.
- **Tugas latar** (`ai/agent/background.js`, fitur `latar`): `start_background_task` menjalankan subagent (loop yang sama, `AGENT_BACKGROUND_MAX_STEPS`/`_TIMEOUT_MS`/`_BUDGET_USD`) di belakang; chat tidak terblokir, subagent tidak bisa memulai subagent lagi, hasil me-reply permintaan (pakai soket terbaru bila WA tersambung ulang). Maks `AGENT_BACKGROUND_MAX_PER_CHAT` per chat dan `_MAX_PER_DAY` per hari; `background_tasks` list/cancel. Tugas latar hilang bila bot restart.

## Skill Bawaan

- Skill = resep langkah kerja dalam Markdown (`ai/skills/builtin/*.md`): frontmatter `name`, `title`, `description`, `requires` (fitur yang dibutuhkan, dipisah koma) + isi langkah. `ai/skills/index.js` memuat bawaan + skill owner di `SKILLS_DIR` (default `data/skills/`, nama sama menimpa bawaan, dibaca ulang tiap 30 detik).
- Prompt agent loop hanya memuat indeks (nama + description) skill yang semua fitur `requires`-nya aktif; tool `use_skill(name)` (fitur `skill`) memuat isi lengkap. Hasil use_skill berlabel `trusted_instructions` (bukan `untrusted_data`) karena ditulis owner/pengembang — jangan pernah membuat skill dari isi chat pengguna tanpa persetujuan owner.
- Bawaan: `qr_code`, `zip_berpassword`, `grafik_data`, `kurs_mata_uang` (open.er-api + frankfurter), `cuaca` (Open-Meteo), `jadwal_sholat` (myquran/Kemenag), `hitung_keuangan`, `patungan`, `riset_perbandingan`, `ringkas_link` (+ cek hoaks), `notulen_rapat`, `stiker_kustom`. Semua API gratis tanpa key, dipanggil lewat `net` di sandbox Python.
- Validasi API nyata: `npm run simulate:skills [-- "pesan" …]`.
- Fitur yang dimatikan disebut di prompt ("sedang dimatikan admin/owner") supaya Grad tidak menjawab "aku nggak punya tool"; tidak berlaku untuk mode nimbrung.

## Dokumen (PDF, Word, PPT, Excel)

- Fitur `dokumen` (default aktif; otomatis mati bila wheel dokumen belum disiapkan → `npm run python:setup`). Parsing & pembuatan memakai library komunitas di sandbox Pyodide: pypdf, python-docx, python-pptx, openpyxl, fpdf2 (+ XlsxWriter, et_xmlfile, defusedxml, typing_extensions). `python-runner.js` memasang wheel PyPI hanya bila kode mengimpornya (`WHEEL_GROUPS`); `extra-wheels.json` versi 2 = map nama → file.
- Masuk: `index.js` mengenali `documentMessage`/`documentWithCaptionMessage` (langsung atau di-reply), riwayat berisi `[dokumen: nama · N hlm · ukuran]` + `entry.document`. File baru diunduh saat `read_document` dipanggil (`setDocumentLoader` → `getRawDocument`, batas `DOC_MAX_MB`).
- `ai/documents/reader.js`: kode ekstraksi konstan (parameter lewat file job JSON, nama file dari pengguna tidak pernah masuk kode), file disimpan di `inbox/` folder kerja chat, hasil di-cache `docs/<sha>.json`. Tampilan per halaman/slide/sheet/bagian, `pages` ("2-5") atau `query` (kata kunci), maks ±8.000 karakter per panggilan. Penjaga: format lama (.doc/.ppt/.xls) ditolak, path di luar folder kerja ditolak, zip bomb (>200 MB terurai / >5000 entri) ditolak, PDF ber-password ditolak.
- PDF hasil scan: halaman dengan teks < 25 karakter dipotong jadi PDF kecil lalu dikirim ke Gemini (`DOC_OCR_MODEL`, default model telinga) lewat plugin OpenRouter `file-parser` engine `native` (±$0,0002/halaman, ±2 dtk). Batas `DOC_OCR_MAX_PAGES` per permintaan dan `DOC_OCR_DAILY_PAGES` per hari; hasil OCR ikut di-cache.
- Keluar: file .pdf/.docx/.pptx/.xlsx/.csv yang disimpan `run_python` ke `out/` dikirim sebagai dokumen WA (kind `document`, maks 16 MB, 3 per run). Skill: `baca_dokumen`, `buat_pdf` (font DejaVu dari matplotlib, fungsi `tulis()` wajib karena `multi_cell` fpdf2 tidak kembali ke margin kiri), `buat_word`, `buat_slide`, `buat_excel`.
- Validasi API nyata: `npm run simulate:documents -- <file> ["pertanyaan" …]`.

## Dashboard Owner (M2c)

- `ai/dashboard/server.js` jalan di proses bot saat `npm start`, hanya `127.0.0.1:7777` (`DASHBOARD_HOST`/`DASHBOARD_PORT`, `DASHBOARD_ENABLED=false` untuk mematikan). Link bertoken dicetak saat start dan lewat `npm run dashboard:link` (token di `data/dashboard-token`).
- Keamanan: cookie HttpOnly SameSite=Strict, Host header dicek (anti DNS rebinding), perubahan wajib Origin sendiri + JSON (anti CSRF), CSP ketat, gambar stiker hanya lewat sha hex. Secret tidak pernah dibaca/dikirim. Jangan pernah membuka port ini ke publik; di VPS pakai `ssh -N -L 7777:127.0.0.1:7777 -p 18173 ubuntu@157.66.55.188`.
- Isi: ringkasan, grup & fitur (toggle + kunci global + log), aktivitas live (SSE dari `ai/observability/activity.js`), stiker (galeri, kurasi/review/buang), memori (clear/reset), jadwal (batalkan), pengaturan runtime.
- Pengaturan runtime (`ai/runtime-settings.js`, file `data/runtime-settings.json`): whitelist kunci non-secret dengan validasi tipe/batas, diterapkan ke `process.env` saat start dan saat diubah (berlaku tanpa restart).
- `.env` adalah rahasia dan tidak boleh di-commit. `.env.example` harus selalu memakai placeholder.

## Checklist Perubahan AI

1. Jalankan `node --check index.js`, `node --check ai/group-agent.js`, `node --check ai/direct-agent.js`, dan `node --check ai/scheduler.js`.
2. Jalankan `npm test`.
3. Untuk perubahan alur pesan, wajib ada tes yang memanggil `processGroupMessage` langsung dengan mock socket; tes helper saja tidak cukup. Untuk DM, panggil `processDirectMessage` dengan mock socket dan pastikan whitelist/broadcast dijaga.
4. Pastikan parameter yang dipakai saat menyimpan riwayat (`senderId`, `senderName`, `text`, mention/reply) diambil dari object argumen atau dideklarasikan lokal—jangan mengandalkan variabel yang tidak berada dalam scope.
5. Benchmark model keputusan ("tanggapi/diam", 46 kasus berlabel termasuk 12 kasus sulit, pertanyaan `noul` yang sama untuk semua model decision + GLM via JSON): `npm run bench:decision [-- --repeat 2 --lang en|id --models jev,tev,mercury,solar,kev,span-lite,span,glm]` (varian `-str` = state teks, `-choice` = format pilihan); hasil di `data/bench/` (tidak masuk git). Retry otomatis untuk 429/5xx. Ringkasan (27 Sep–1 Okt, @0,5): Jev 90–92% (lama 94–100%, sulit 67–88%), p50 ±0,6 dtk, ±$0,019/1000; **Mercury-decide:free 93–97% (sulit 83–88%) tapi p50 ±3 dtk saat beban beruntun (±0,65 dtk sekali panggil), sering 503, jawaban kasus ambang tidak stabil, dan tier gratis = tanpa SLA/privasi tak terjamin**; tev1-4b 83–85% (cenderung diam), ±$0,011/1000; Solar-decide 54–55% (hampir selalu "tanggapi"); GLM 99% tapi 2 dtk; Kev 78%; Span 76%/66%. Span hanya menerima `noul` + state string; `typesafe/jev-router` bukan model keputusan. **liquid/d1 (2 Okt, `--models d1`):** instruksi en 96% (sulit 83%) vs Jev 90% (63%); instruksi id 92% vs Jev 93% (d1 lebih sering terlewat/diam, Jev lebih sering nyelonong); p50 0,47 vs 0,35 dtk; ±$0,009 vs $0,019/1000. Ganti lewat `JEV_MODEL=liquid/d1`.
6. Untuk validasi API nyata gunakan `npm run simulate:agent -- [voice.ogg] [musik.ogg]` (skenario demo M1), `npm run simulate:ai`, `npm run simulate:burst`, `npm run simulate:memory`, atau `npm run simulate:dm`; jangan mencetak API key.
7. Tes tidak boleh memakai key asli: `test/helpers/test-env.js` mengosongkan `OPENROUTER_API_KEY`; tes AI memakai `test/helpers/mock-openrouter.js`.

## Env

`~/.bashrc` berisi: PATH opencode (`~/.opencode/bin`), `HTTP_PROXY`/`HTTPS_PROXY` → 8118, alias `oc` (chat lanjut sesi), `ocn` (chat baru), `oct` (TUI).
