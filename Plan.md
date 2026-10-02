# Plan Overhaul v2: Grad Agentic, Feature First

Tanggal: 26 September 2026
Status: rencana, belum diimplementasi.
Plan v1 (gagal terasa) diarsipkan di [`docs/overhaul/PLAN_V1.md`](docs/overhaul/PLAN_V1.md).
Baseline kode: branch `agent-overhaul-baseline` (PR #1).

## 1. Kenapa overhaul v1 tidak terasa

| Masalah v1 | Akibatnya | Aturan v2 |
|---|---|---|
| Engine default `legacy`, semua `AGENT_*_ENABLED=false` | Dari WhatsApp, bot identik dengan sebelum overhaul | Tidak ada fitur "selesai" yang mati default. Selesai = aktif di WA. |
| Router tugas pakai regex (`intent-router.js`) | Tugas hanya jalan lewat `/task …` dengan kata kunci persis | Model yang memutuskan. Regex hanya untuk command admin. |
| Planner sekali jalan (`planner.js`), replan hanya untuk `read_note` | Agen tidak bisa bereaksi terhadap hasil tool | Loop tool-calling: GLM melihat setiap hasil tool sebelum langkah berikutnya. |
| Infra dulu (lease, fencing, outbox, canary, shadow, 3 engine mode) | ±4.000 baris tanpa fitur yang bisa dirasakan | Infra hanya dibangun kalau sebuah fitur butuh. |
| "Lulus" = mock + dokumen laporan | Progres terlihat di dokumen, tidak di chat | Setiap milestone ditutup dengan demo di grup WA nyata. |
| Bug scheduler legacy tidak disentuh | Reminder bisa hilang saat crash atau `/agent off` | Jalur yang jalan di produksi diperbaiki dulu. |

## 2. Keputusan pengguna (26 Sep 2026)

| Topik | Keputusan |
|---|---|
| Pemicu tugas | **Bahasa natural.** Cukup mention, reply, atau DM bot. Model yang memutuskan apakah itu tugas. |
| Prioritas fitur | 1. **Web search** (pakai bawaan OpenRouter), 2. **Koleksi stiker Grad** (§4a), 3. **Reminder & jadwal**, 4. **Memori & catatan** |
| Stiker | **Tidak ada stiker hasil generate/cari gambar.** Grad mengumpulkan stiker yang dipakai manusia, mengkurasi koleksinya sendiri, lalu memakainya. |
| Koleksi stiker | Satu koleksi **global**. Stiker berisi wajah/foto member atau inside joke ditandai **lokal** (hanya grup asal). Sumber: **grup + DM**. Kurasi **harian**, review **mingguan**, kapasitas **~150**. |
| Pemakaian stiker | Pengganti balasan, pelengkap teks, pengganti reaction, dan saat nimbrung sosial. |
| Otonomi | **Bebas penuh di chat asal.** Tidak ada konfirmasi. Dibatasi hanya oleh aturan keras (§6). |
| Proaktif | **Proaktif di grup juga.** Dinamis: ikut ngobrol seperti member (dibatasi cooldown), dan selalu boleh muncul kalau ada bantuan nyata yang bisa dia berikan. |
| Infra v1 | **Dipangkas**, dipakai seperlunya. |
| Rilis | **Langsung ke semua grup** yang diizinkan, begitu fitur lulus tes. Tanpa shadow atau canary. |
| Batas per tugas | **Besar: ~25 langkah** (tool call) per tugas. |

## 3. Bentuk agen yang dituju

```text
Pesan WA (grup/DM)
  → normalisasi + identitas PN (index.js, sudah ada)
  → Jev: ignore / react / engage          ← cepat & murah, sudah ada
       └ engage → Agent Loop (GLM + tools)
            ┌─────────────────────────────────────────────┐
            │ GLM(tools, riwayat, memori) → tool_calls?    │
            │   ya → jalankan tool → hasil → balik ke GLM │
            │   tidak → teks final → kirim ke chat asal    │
            └─────────────────────────────────────────────┘
            batas: 25 langkah · ~3 menit · budget token
  → kirim (typing presence, split natural, quote bila perlu)
```

Perubahan konsep terpenting: **tidak ada lagi dua jalur "chat" dan "task"**. Setiap kali Jev memilih *engage*, GLM dipanggil **dengan tools**. Obrolan biasa berarti GLM menjawab tanpa memanggil tool. Permintaan seperti "carikan X lalu bandingkan" berarti GLM memanggil tool berulang sampai selesai. Tidak ada `/task` yang perlu dihafal.

### Peran model

- **Jev** (`typesafe/jev-1.13`): gerbang keterlibatan. Pilihan yang ada sekarang (`ignore`, `reply`, `react_*`) dipertahankan. `reply` diganti maknanya menjadi `engage` (masuk agent loop), dan ditambah sinyal `opportunity` untuk proaktif (§5). Jev tidak memilih tool.
- **GLM** (`z-ai/glm-5.3-flash`): otak loop. Memakai native tool calling OpenRouter (`glm-client.js` sudah mendukung `tools`/`tool_choice`), reasoning `low`, dan boleh menaikkan ke `medium` untuk tugas multi-langkah.
- **Kode runtime**: menegakkan aturan keras, batas langkah, timeout, dan budget. Tujuan pengiriman selalu chat asal, tidak pernah dari argumen model.

### Pesan progres

Tugas yang lebih dari ~2 tool call atau lebih dari ~8 detik mengirim satu pesan singkat natural ("bentar, aku cariin dulu ya") plus presence `composing`. Tujuannya supaya grup tahu bot sedang bekerja. Paling banyak satu pesan progres per tugas, kecuali tugasnya lebih dari 60 detik.

### Pesan baru saat loop berjalan

- Pesan baru di chat yang sama dimasukkan ke loop yang sedang berjalan sebagai konteks tambahan pada langkah berikutnya, tidak memulai loop kedua.
- "stop"/"batal" yang ditujukan ke bot menghentikan loop.
- Satu loop aktif per chat.

## 4. Katalog tools (target akhir)

| Tool | Milestone | Keterangan |
|---|---|---|
| `web_search` | M1 | **Server tool bawaan OpenRouter** (`openrouter:web_search`) dipasang langsung di request GLM, bukan wrapper terpisah. Tanpa batas "1 pencarian/tugas" dari v1; dibatasi oleh langkah/budget. |
| `web_fetch` | M1 | Baca halaman URL. Pakai ulang `safe-web-fetch.js` (SSRF guard). Allowlist host diganti blocklist privat. |
| `send_sticker` | M2 | Kirim stiker **dari koleksi Grad** (`sticker_id`) ke chat asal, sebagai pengganti balasan atau pelengkap teks (§4a). |
| `get_chat_media` | M2 | Ambil gambar/video dari pesan di riwayat (berdasarkan `entry_id`) atau pesan yang di-reply, untuk dianalisis. |
| `schedule` | M3 | Reminder sekali atau berulang dengan waktu WIT eksplisit. |
| `list_schedules` / `cancel_schedule` | M3 | Lihat dan hapus jadwal di chat itu. |
| `remember` / `recall` / `forget` | M4 | Fakta tentang orang, grup, atau preferensi, dengan sumber dan scope chat. |
| `note_write` / `note_read` / `note_list` | M4 | Catatan grup. |
| `summarize_history` | M4 | Ringkas riwayat aktif chat. |

Kontrak tool: schema JSON (`inputSchema`), handler, timeout, dan hasil ringkas untuk model. Pakai ulang `capabilities/registry.js` tetapi hapus kewajiban verifier, idempotency key, dan approval untuk tool read-only.

## 4a. Koleksi stiker Grad

Grad tidak membuat stiker. Dia **mengumpulkan stiker yang dipakai manusia**, memilih sendiri mana yang layak disimpan, memberinya makna, lalu memakainya seperti manusia memakai koleksi stiker di HP-nya.

```text
stiker lewat di chat ──► KANDIDAT (hash, hitungan, konteks)
                              │  kurasi harian (GLM lihat gambar + statistik)
                    ┌─────────┴─────────┐
                  skip                simpan + label
             (bisa dinilai ulang     (makna, mood, kapan dipakai,
              kalau terus muncul)     rencana frekuensi, global/lokal)
                                           │
                               dipakai Grad di obrolan
                                           │  review mingguan
                                   tetap / BUANG (dengan alasan)
```

### Pengumpulan (pasif, jalan terus)
- Setiap `stickerMessage` di grup yang diizinkan atau DM yang di-whitelist dicatat. Identitasnya `fileSha256` dari pesan WA, jadi stiker yang sama terhitung berulang tanpa unduh ulang.
- Saat pertama terlihat, stiker diunduh sekali ke `data/stickers/candidates/<sha>.webp`. Ukuran stiker kecil, dan link media WA bisa kedaluwarsa.
- Statistik per stiker: `use_count` (dipakai manusia), `distinct_chats`, `distinct_senders`, `first_seen`, `last_seen`, `animated`, dan maksimal 5 **cuplikan konteks** (1–2 pesan sebelum dan sesudah stiker, sudah melalui redaksi) supaya GLM tahu stiker itu dipakai untuk apa.
- Stiker dari DM hanya menambah statistik dan kandidat. Konteks DM tidak pernah ikut ke prompt grup.
- Stiker yang dikirim Grad sendiri tidak dihitung sebagai pemakaian manusia.

### Kurasi harian (GLM, di jam tenang WIT)
- Kandidat baru dikirim ke GLM **multimodal** dalam batch ~10. Stiker animasi diwakili 1–3 frame PNG.
- Untuk tiap stiker GLM menerima gambar, statistik, dan cuplikan konteks. Keluarannya terstruktur:
  - `decision`: `keep` / `skip`
  - `label`: makna singkat ("ngakak sampe nangis", "sindiran halus", "capek kerja")
  - `moods`: tag, misalnya `laugh`, `ack`, `sad`, `tease`, `love`, `confused`, `hype`
  - `when_to_use`: satu kalimat kapan cocok dipakai
  - `planned_frequency`: `sering` / `kadang` / `jarang` (rencana Grad sendiri seberapa sering memakainya)
  - `scope`: `global`, atau `local` kalau ada wajah/foto member atau inside joke grup tertentu
  - `reason`: alasan singkat (kenapa disimpan atau di-skip)
- Stiker NSFW, SARA, atau yang merendahkan orang nyata selalu `skip` (dicek ulang oleh aturan kode).
- Stiker yang di-skip tidak dinilai ulang, **kecuali** pemakaiannya oleh manusia naik signifikan (misalnya hitungan ≥3× sejak keputusan terakhir). Stiker yang terus muncul layak dilihat lagi.
- Kandidat skip yang tidak muncul lagi selama 30 hari dihapus dari disk.

### Review mingguan
- GLM melihat seluruh koleksi beserta statistiknya: berapa kali dipakai Grad, kapan terakhir, apakah manusia masih memakainya, dan label-label yang mirip.
- GLM boleh **membuang** stiker dengan alasan masuk akal: sudah basi (trennya lewat), terlalu mirip stiker lain yang lebih bagus, tidak pernah cocok dipakai, atau labelnya ternyata salah. GLM juga boleh **merevisi** label dan `planned_frequency`.
- Kapasitas ~150. Kalau kandidat baru bagus tapi koleksi penuh, GLM harus memilih mana yang dibuang.
- Semua keputusan (simpan, skip, buang, revisi) dicatat di log beserta alasannya, dan bisa dilihat owner.

### Pemakaian
- Indeks ringkas koleksi (id, label, mood, frekuensi, terakhir dipakai) masuk ke konteks GLM di agent loop. Stiker `local` hanya muncul di grup asalnya.
- **Pengganti balasan / pelengkap teks:** GLM memanggil `send_sticker(sticker_id, placement: only|after_text)`.
- **Pengganti reaction:** saat Jev memilih `react_laugh`/`react_ack`/`react_heart`, sesekali (peluang dari `.env`) diganti stiker dengan mood yang cocok. Stiker dipilih deterministik dari koleksi, tanpa panggilan GLM tambahan.
- **Nimbrung sosial (M5):** stiker jadi salah satu cara ikut meramaikan.
- Rem pemakaian: `planned_frequency` menentukan jeda minimum per stiker, ada batas stiker per jam per grup, dan stiker yang sama tidak dipakai dua kali berturut-turut di chat yang sama.

### Kontrol owner
- `/stiker` menampilkan jumlah koleksi dan kandidat, 10 stiker terfavorit Grad, serta keputusan terakhir.
- `/stiker lihat <id>` mengirim stiker beserta label dan alasannya.
- `/stiker buang <id>` untuk membuang manual (tercatat).
- `/stiker kurasi` untuk menjalankan kurasi sekarang.
- `/s` (bikin stiker dari foto sendiri) tetap ada sebagai command biasa, terpisah dari koleksi.

### Penyimpanan
- SQLite (`storage/` v1 dipakai ulang): tabel `sticker_candidates`, `sticker_collection`, `sticker_decisions`, `sticker_usage`. File di `data/stickers/{candidates,collection}/<sha>.webp`, dan folder ini masuk `.gitignore`.

## 4b. Audio lewat Gemini Flash ("telinga" Grad)

GLM 5.3 Flash tidak menerima audio. Berdasarkan daftar model OpenRouter per 26 Sep 2026, input GLM hanya `text,image,video`. GLM tetap jadi otak. Audio diserahkan ke **Gemini Flash**, dan Gemini hanya bertugas mendengar lalu melaporkan isinya sebagai teks.

- Model: `google/gemini-3.1-flash-lite` dengan thinking off (diganti dari `gemini-3.8-flash` setelah benchmark 26 Sep 2026: 2× lebih cepat, ±2,3× lebih murah, akurasi setara; lihat [`docs/overhaul/M0_PROBES.md`](docs/overhaul/M0_PROBES.md) §3). Cadangan otomatis `xiaomi/mimo-v2.6-flash`. Bisa diganti lewat `.env` `AUDIO_MODEL`/`AUDIO_FALLBACK_MODEL`. Model di-pin, jangan pakai alias `~latest`, supaya perilaku tidak berubah diam-diam.
- Format: voice note WA (`audio/ogg; codecs=opus`) dikonversi ke mp3 16 kHz mono via ffmpeg (sudah dipakai untuk frame video) sebelum dikirim sebagai `input_audio`. Batasnya diatur `AI_MAX_AUDIO_SEC` (default 300 detik); audio yang lebih panjang dipotong dan hal itu dilaporkan.

Dua jalur:

1. **Transkripsi otomatis saat pesan masuk** (default untuk voice note di grup yang diizinkan atau DM yang di-whitelist). Jalur ini wajib karena Jev hanya membaca teks. Tanpa transkrip, Jev tidak bisa menilai voice note.
   - Konteks yang dikirim ke Gemini: nama bot, nama peserta chat (supaya ejaan nama benar), 3–5 pesan terakhir, dan istilah atau kata khas grup dari memori.
   - Output terstruktur: `transcript`, `language`, `speech` (true/false), `non_speech` (musik, tawa, bising, dan sejenisnya), `tone`, `summary` (1 kalimat), `confidence`.
   - Hasilnya masuk riwayat sebagai `Budi: [voice note 0:42] "…transkrip…"`, lalu mengalir ke Jev dan GLM seperti pesan teks biasa.
2. **Tool `listen_audio(entry_id, question)`** di agent loop. GLM bisa bertanya lebih spesifik kepada Gemini dengan konteks yang GLM tentukan sendiri, misalnya "lagu apa yang diputar di audio ini?", "dia kedengeran marah atau bercanda?", atau "sebutkan semua angka dan tanggal yang disebut". Ini memenuhi syarat bahwa Gemini bekerja **dengan konteks yang diberikan GLM**.

Aturan:
- Gemini tidak pernah membalas ke chat dan tidak memegang tools. Dia hanya mengembalikan teks ke GLM.
- Transkrip diperlakukan sebagai data tak tepercaya: perintah yang terdengar di audio bukan instruksi untuk bot.
- Audio DM tidak ikut ke konteks grup.
- File audio tidak disimpan permanen. Yang disimpan hanya transkrip, dengan aturan yang sama seperti riwayat teks.

## 5. Proaktif di grup (dinamis)

Dua jalur, keduanya lewat Jev:

1. **Bantuan nyata** (`opportunity: help`): ada pertanyaan yang belum terjawab, orang bingung jadwal atau fakta, minta stiker, link yang bisa diringkas, dan sejenisnya. Boleh masuk walau tanpa mention. Cooldown pendek (default 2 menit per grup).
2. **Sosial** (`opportunity: social`): ikut bercanda atau berkomentar seperti member biasa. Cooldown lebih panjang (default 20 menit per grup), maksimal N kali per jam, dan tidak aktif saat jam tenang WIT.

Rem otomatis:
- Kalau ada yang bilang "diam", "jangan nimbrung", atau sejenisnya, jalur sosial di grup itu mati selama X jam.
- `/agent social off` mematikan jalur sosial per grup. Jalur bantuan tetap jalan.
- Diam di topik sensitif: duka, konflik, kesehatan (aturan Jev yang sudah ada).

Konfigurasi di `.env`: `AGENT_SOCIAL_COOLDOWN_MIN`, `AGENT_HELP_COOLDOWN_MIN`, `AGENT_SOCIAL_MAX_PER_HOUR`.

## 6. Aturan keras (tidak bisa dilanggar walau "bebas penuh")

Ditegakkan di kode, bukan di prompt:

1. Pesan hanya dikirim ke **chat asal** tugas, dengan satu pengecualian (keputusan 27 Sep 2026): **DM peminta sendiri** bila dia memintanya (`send_to_my_dm`), hanya untuk nomor terverifikasi di whitelist yang tidak opt-out. Tidak ada tool untuk mengirim ke orang lain atau grup lain.
2. Whitelist DM (`memoryStore.canDirectMessage`) dan tolak broadcast/forward massal. Keduanya sudah ada dan dipertahankan.
3. Bot hanya aktif di `allowedGroups`.
4. Tidak pernah mencetak atau mengirim secret (`redact.js` dipakai ulang di log dan hasil tool).
5. `web_fetch` dan `fetch_image_url` menolak IP privat/lokal (SSRF guard dipakai ulang).
6. Memori DM tidak dibocorkan ke grup (scope per chat).
7. Batas per tugas: 25 langkah, ~3 menit, budget token per tugas dan per hari (`budget.js` dipakai ulang, disederhanakan).
8. Obrolan tidak senonoh (2 Okt 2026): Grad tidak ikut; reaction/stiker/nimbrung ditahan dan diganti teguran halus ber-cooldown (`ai/agent/decency.js`), dan GLM selalu punya `stay_silent` sebagai lapisan kedua setelah Jev.
9. Kill switch: `/agent off` (owner) mematikan loop agen, dan emergency pause tetap ada. **Reminder yang diminta pengguna tetap jalan** walau agent off.

## 7. Nasib kode v1

| Pertahankan / pakai ulang | Sederhanakan | Buang (hapus dari jalur aktif) |
|---|---|---|
| `providers/*` (Jev, GLM, OpenRouter client) | `capabilities/registry.js` (tanpa idempotency/verifier wajib) | `runtime/lease-manager.js`, fencing |
| `observability/redact.js`, `trace.js` | `runtime/budget.js` (satu budget sederhana) | `runtime/canary.js`, mode shadow, 3 engine mode (`engine-config.js`) |
| `runtime/safe-web-fetch.js`, `safe-media-fetch.js`, `egress-limiter.js` | `storage/` SQLite: hanya untuk jadwal + log tugas | `runtime/outbox.js`, `inbox.js` (ganti dedupe Map sederhana) |
| `media/*` (validator, video frame; sticker converter hanya untuk `/s`) | `memory-store.js` + `memory-facts.js` digabung | `runtime/planner.js`, `task-runner.js`, `verifier.js`, `task-state-machine.js`, `intent-router.js` |
| `policy/authorize.js` (siapa boleh `/agent`, `/veto`) | `scheduler.js`: satu scheduler, tahan crash | `durable-scheduler.js` (setelah digabung), `recovery.js`, `lifecycle.js` bagian shadow/canary |
| Tes regresi grup/DM yang ada | | Tes yang hanya menguji modul yang dibuang, beserta dokumen fase v1 (diarsipkan) |

Kode yang dibuang tetap ada di git (PR #1). Hapus hanya setelah pengganti di milestone terkait lulus.

## 8. Milestone (feature first)

Setiap milestone baru dianggap **selesai** kalau:
- tes lulus (`npm test`, termasuk tes `processGroupMessage`/`processDirectMessage` dengan mock socket sesuai AGENTS.md),
- deploy ke VPS (restart `tmux send-keys -t wabot C-c`),
- ada **demo nyata di grup WA** yang dicoba owner, dengan skenario yang ditulis di milestone.

### M0 · Beres-beres jalur produksi (kecil, ≤1 hari)

> **Status 26 Sep 2026: kode + probe selesai, tinggal deploy & demo WA.**
> - Scheduler: job diklaim → dikirim → baru dihapus (at-least-once), backoff 1/2/4/8 menit (maks 5 percobaan), klaim proses yang crash diambil ulang, tick tidak tumpang tindih, reminder tetap jalan saat `/agent off`, job jatuh tempo langsung jalan begitu tersambung.
> - Probe: GLM tool calling + web search stabil 3/3, tanpa fallback envelope. Gemini audio akurat untuk slang, 3–6,5 detik. Detail di [`docs/overhaul/M0_PROBES.md`](docs/overhaul/M0_PROBES.md).
> - Stiker: `ai/stickers/collector.js` (SQLite `data/stickers/stickers.db` + `candidates/<sha>.webp`), `/stiker` untuk owner. `/s` tetap pembuat stiker (alias `/stiker` lama dipindah).

- Perbaiki `legacyRunDueJobs` di `ai/scheduler.js`: klaim job tanpa menghapus sebelum sukses, dan reminder tetap jalan saat agent off.
- Probe OpenRouter: GLM + native tool calling + `openrouter:web_search` dalam satu request. Catat hasilnya (tanpa API key). Kalau tool calling GLM tidak stabil, fallback ke action envelope JSON tervalidasi Ajv, dengan loop yang sama.
- Probe Gemini Flash audio: voice note ogg → mp3 → `input_audio`, cek kualitas transkrip bahasa Indonesia campur slang, dan cek latensi.
- **Mulai pengumpulan stiker** (hanya tahap pengumpulan di §4a: hash, unduh, statistik, konteks). Tujuannya supaya kandidat sudah menumpuk saat M2 dimulai.
- **Demo:**
  - set reminder 2 menit, restart bot di tengah, dan reminder tetap datang
  - `/stiker` menunjukkan kandidat bertambah setelah orang kirim stiker

### M1 · Agent loop + Web search ⭐ fitur pertama

> **Status 26 Sep 2026: kode selesai + divalidasi dengan API nyata, tinggal deploy & demo WA.**
> - `ai/agent/{loop,tools,format,active-loops,usage}.js`, `ai/audio/{ears,voice-notes}.js`. Grup & DM memakai loop yang sama; `routeTaskIntent` dihapus dari `index.js`; `/task` = alias.
> - Temuan: GLM mengabaikan `response_format` saat tools aktif → jawaban akhir teks bebas + penanda `[[reply:#id]]`. `safeWebFetch` v1 **tidak pernah berhasil di Node ≥20** (lookup `{all:true}`), sudah diperbaiki + tes regresi.
> - Simulasi nyata (`npm run simulate:agent`): obrolan 2,6 s tanpa tool; harga iPhone 17 vs 16 = 1 web search, 7 s, $0,015; rangkum Wikipedia = 1 fetch, 14 s, $0,001; voice note "besok rapat jam berapa" dijawab dari riwayat; "ini lagu apa?" = listen_audio + web search verifikasi lirik, 63 s (2 pesan progres), $0,025.

- `ai/agent/loop.js`: loop tool-calling (maks 25 langkah, timeout, budget, stop/batal, pesan progres).
- Jev `reply` → `engage` → loop. Balasan biasa lewat loop yang sama (GLM boleh tidak memanggil tool).
- Tools: `web_search` (server tool OpenRouter), `web_fetch`.
- Hapus jalur `routeTaskIntent` dari `index.js`, dan jadikan `/task` alias ke loop.
- Audio (§4b): transkripsi otomatis voice note via Gemini Flash dan tool `listen_audio`.
- **Demo:**
  - "@Grad harga iPhone 17 di Indonesia sekarang berapa? bandingin sama iPhone 16"
  - "@Grad rangkum link ini <url>"
  - kirim voice note "grad, besok rapat jam berapa?" → Grad paham dan menjawab
  - reply voice note berisi musik: "@Grad ini lagu apa?" → GLM memanggil `listen_audio`
  - obrolan biasa tetap natural, tanpa link atau format aneh.

### M2 · Koleksi stiker Grad

> **Status 26 Sep 2026: kode selesai + divalidasi dengan GLM nyata, tinggal demo WA (lokal).**
> - `ai/stickers/{library,curator,commands}.js`; tool `send_sticker` + `get_chat_media`; stiker pengganti reaction; penjadwal kurasi harian/review mingguan.
> - Kurasi nyata (5 stiker uji): 3 stiker umum disimpan global, stiker lelucon member disimpan **lokal**, gambar acak di-skip dengan alasan; ±$0,001 per batch. Obrolan curhat lembur → teks + stiker "capek"; pertanyaan informatif → tanpa stiker.
> - Karena bot jalan di laptop, kurasi harian juga jalan bila sudah ≥36 jam sejak kurasi terakhir (tidak hanya di jam tenang).
- Kurasi harian dan review mingguan (§4a), log keputusan, dan kapasitas ~150.
- Tool `send_sticker`, indeks koleksi di konteks GLM, stiker pengganti reaction, dan rem pemakaian.
- Command `/stiker`, `/stiker lihat|buang|kurasi`.
- Tool `get_chat_media` untuk menganalisis media di riwayat.
- **Demo:**
  - `/stiker kurasi` → GLM menyimpan sebagian kandidat dengan label masuk akal dan men-skip sisanya dengan alasan
  - bercanda dengan Grad → dia kadang membalas pakai stiker koleksinya yang cocok
  - stiker berisi wajah member grup A tidak pernah muncul di grup B
  - `/stiker` menunjukkan keputusan buang dari review mingguan

### M2b · Fitur per grup (keputusan 26 Sep 2026)

> **Status 26 Sep 2026: kode selesai + tes, tinggal demo WA (lokal).** Termasuk tambahan: tool `save_sticker` (simpan stiker atas permintaan lalu langsung pakai). **Perbaikan 27 Sep (dari demo WA):** save_sticker wajib melihat stikernya dulu (label tidak lagi dikarang), tool `remove_sticker` untuk owner/admin/veto, statistik `/stiker` dibetulkan. **Mata gerak (27 Sep):** stiker animasi & GIF ditonton Gemini Flash Lite sebagai video diperlambat 4× (probe: Gemini 6/6 vs GLM 2/6 untuk gerakan singkat), deskripsinya dipakai riwayat, kurasi, dan save_sticker; divalidasi API nyata (kucing hijau → "katak mukul kesel", kuda → "kuda nabrak tembok gokil").

- Setiap kemampuan Grad bisa dinyalakan/dimatikan per grup. Ditegakkan di kode: tools fitur yang mati tidak dikirim ke GLM, dan proses non-tool (transkripsi audio, pengumpulan stiker, stiker pengganti reaction) ikut berhenti.
- Fitur dan default: `web` on, `audio` on, `stiker` on, `media` on, `reminder` on (M3), `sosial` off (M5), `workspace` off, `python` on, `skill` on (M4b; diperbarui 27 Sep 2026).
- Dua level: **owner** mengunci/membuka fitur secara global; **admin WA grup** + owner mengatur per grup, hanya dalam batas yang dibuka owner. Status admin dicek langsung ke metadata grup setiap command.
- Pengaturan lewat **DM** supaya tidak meramaikan grup: `/grup` (daftar grup yang dia admin-i), `/fitur <no>` (status), `/fitur <no> <fitur> on|off`. Owner juga bisa `/fitur global <fitur> kunci|buka`.
- Perubahan **senyap** (tidak diumumkan). Di grup, siapa pun bisa kirim `/fitur` untuk melihat status (read-only). Semua perubahan dicatat (siapa, kapan, sebelum/sesudah).
- Pemegang `/veto` tidak ikut mengatur fitur.
- **Demo:** admin grup DM `/fitur 1 stiker off` → Grad berhenti memakai dan mengumpulkan stiker di grup itu; `/fitur` di grup menampilkan status; owner mengunci `web` → admin tidak bisa menyalakannya.

### M2c · Dashboard owner (lokal)

> **Status 26 Sep 2026: kode selesai + tes keamanan, dicek di browser dengan data contoh.** Buka lewat link yang dicetak `npm start` atau `npm run dashboard:link`.

- Server HTTP di dalam proses bot, hanya `127.0.0.1:7777` (`DASHBOARD_HOST`/`DASHBOARD_PORT`). Satu halaman HTML + JS tanpa framework, update live via Server-Sent Events.
- Keamanan: token akses di `data/dashboard-token` (tetap walau restart), link dicetak saat start dan lewat `npm run dashboard:link`; header `Host`/`Origin` dicek (anti CSRF/DNS rebinding); secret (`.env`, API key, `auth/`) tidak pernah tampil/berubah.
- Isi: ringkasan (koneksi WA, uptime, model, agen on/off, pemakaian & biaya hari ini), grup (fitur per grup, kunci global, log perubahan), aktivitas (log tugas live), stiker (galeri, kandidat, keputusan, tombol kurasi/review/buang), memori (per grup, profil, clear/reset), jadwal (job aktif, batalkan), pengaturan runtime (budget, peluang stiker, kapasitas) yang disimpan di file pengaturan, bukan `.env`.
- Di VPS diakses lewat SSH tunnel: `ssh -N -L 7777:127.0.0.1:7777 -p 18173 ubuntu@<vps>`, lalu buka `http://127.0.0.1:7777`. Alternatif: Tailscale (`DASHBOARD_HOST` = IP Tailscale). Tidak pernah membuka port publik.
- **Demo:** buka dashboard di laptop → matikan fitur grup, lihat log tugas masuk live saat ada yang mention Grad, lihat galeri stiker dan jalankan kurasi.

### M3 · Reminder & jadwal

> **Status 26 Sep 2026 (malam): kode selesai + divalidasi API nyata, tinggal demo WA.** Tool schedule/list/cancel, reminder & tugas berulang ke chat asal (grup/DM), tugas mingguan menjalankan loop (uji: jadwal bola → web search → daftar per hari).

- Tools: `schedule` (sekali/berulang, WIT), `list_schedules`, `cancel_schedule`, di atas scheduler M0.
- Saat jatuh tempo, job boleh **menjalankan loop agen** ("tiap pagi jam 7 kirim ringkasan berita X"), tetap hanya ke chat asal.
- **Demo:**
  - "ingetin grup ini besok jam 8 buat rapat"
  - "tiap Senin jam 7 cariin jadwal bola minggu ini"
  - "jadwal apa aja yang aktif?" / "batalin yang rapat"

### M4b · Workspace, Python sandbox & skill

> **Status 27 Sep 2026: Python sandbox selesai tanpa Docker (Pyodide + permission model Node), divalidasi API nyata: QR, cicilan anuitas, grafik kurs USD/IDR dari API frankfurter. Uji pembobolan (.env, run_js, spawn, fetch langsung, mount, SSRF, loop) semua tertahan.** **Update malam 27 Sep: `python` kini aktif default (keluhan "Grad nggak punya tool QR"), dan 11 skill bawaan jalan (use_skill + indeks di prompt), divalidasi API nyata: QR teks/WiFi, kurs, cuaca, jadwal sholat, patungan, cicilan flat.** **Update 27 Sep: dukungan dokumen — baca PDF/DOCX/PPTX/XLSX/CSV (read_document, cache, query/pages), OCR PDF scan via Gemini, buat PDF/Word/slide/Excel lewat run_python + 5 skill; divalidasi API nyata.** Belum: tools `ws_*` terpisah dan `write_skill` (skill buatan Grad + persetujuan owner).
- `workspace/<chat>/files/` per grup/DM, tools `ws_list`/`ws_read`/`ws_write` (path dikunci ke folder chat). Catatan grup M4 menjadi file di sini.
- `run_python(code)` di container Docker sekali pakai: hanya mount workspace chat itu, tanpa `.env`/`auth/`/folder project, batas CPU/RAM/waktu, internet keluar tanpa IP privat. Butuh Docker (Desktop/WSL2 di laptop). Fitur `python` terkunci global secara default.
- Skill ala Hermes: `workspace/skills/<nama>/SKILL.md` (frontmatter name, description, scope, pembuat). Indeks (name + description) masuk prompt; `read_skill` memuat isi saat dibutuhkan; `write_skill` membuat/memperbarui setelah tugas berhasil. Skill baru lokal ke chat pembuatnya; menjadi global hanya lewat persetujuan owner (dashboard atau `/skill setujui`).
- Semua di bawah toggle M2b (`workspace`, `python`, `skill`).

### Lanjutan 27 Sep 2026 · FFmpeg, DM peminta, tugas latar

> **Status: kode selesai + divalidasi API nyata.**
> - `media_edit` (FFmpeg, operasi dikurasi): video/GIF → stiker animasi, potong, kompres, mp3, frame, teks, speed, reverse, crop, gabung. Uji: stiker 3 detik bertulisan "GAS", audio → MP3.
> - `send_to_my_dm`: hasil/teks ke DM peminta sendiri (hasil media bisa dipindah dari grup). Uji: rangkuman obrolan ke DM, grup hanya konfirmasi.
> - `start_background_task` / `background_tasks`: subagent latar (40 langkah, 15 menit, $0,5), ack cepat, hasil me-reply permintaan. Uji: riset 3 laptop gaming + grafik, ack 9 dtk, hasil 25 dtk kemudian.

### M4 · Memori & catatan

> **Status 26 Sep 2026 (malam): kode selesai + divalidasi API nyata, tinggal demo WA.** remember/recall/forget + note_* + summarize_history, scope per chat, fakta masuk konteks (uji: alergi udang → rekomendasi makanan tanpa seafood; catatan rapat ditulis & dibaca ulang).

- Tools: `remember`/`recall`/`forget`, `note_*`, `summarize_history`.
- Compact memori yang ada tetap jalan, dan fakta hasil compact bisa dicari lewat `recall`.
- **Demo:**
  - "inget ya aku alergi udang" lalu beberapa hari kemudian "rekomendasiin makanan buat aku"
  - "catat keputusan rapat tadi" / "catatan kemarin apa aja?"

### M5 · Proaktif grup dinamis

> **Status 26 Sep 2026 (malam): kode selesai + disimulasikan dengan gaya obrolan grup Yy & Tes Bot <3.** Sinyal Jev `opportunity`, jalur bantuan & sosial dengan rem, "grad diem dulu" menahan semua respons ke pesan yang tidak memanggil bot, `/agent social on|off`. Simulasi: "Aku bosaaaan" → stiker bosen; "HAHAHA malu banget" → stiker ngakak; sebagian momen dilewati (tidak spam). Sosial mati di jam tenang (22–07 WIT).

> **Update 27 Sep (dari demo WA):** Jev tepat saat memilih diam, tapi sering salah memilih reaction vs balasan untuk pesan yang ditujukan ke bot. Kini pilihan reaction Jev pada pesan yang ditujukan ke bot diteruskan ke GLM, yang memilih teks/stiker/reaction sendiri (tool `react`). Divalidasi API nyata dengan ulangan percakapan demo: ajakan tebak stiker → "Siap, kirim aja"; "Iyap, simpan dong" → save_sticker; "sip makasih" → 👍.

- Sinyal `opportunity` di Jev, cooldown dua jalur, rem otomatis, `/agent social on|off`.
- **Demo:** ada yang bertanya fakta tanpa mention → bot menjawab. Ada candaan → bot sesekali ikut. Ada yang bilang "grad diem dulu" → bot diam.

### M6 · Pangkas v1
- Hapus modul di kolom "Buang" §7 beserta tesnya, arsipkan dokumen fase v1, perbarui AGENTS.md dan README.

## 9. Observabilitas minimum

- Satu baris log per tugas: chat, jumlah langkah, tools yang dipakai, token, durasi, dan status. Tanpa isi pesan pribadi atau secret.
- `/agent status`: status on/off, jumlah tugas hari ini, token terpakai, dan cooldown per grup.
- Trace detail per tugas (`trace.js`) hanya untuk debugging lokal.

## 10. Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| Biaya: 25 langkah × semua grup | Budget harian di `.env`. Setelah budget habis, loop turun ke balasan tanpa tools. Log token per tugas. |
| Proaktif sosial terasa spam | Cooldown, kuota per jam, rem "diam", `/agent social off`. Mulai dengan nilai konservatif. |
| Tool calling GLM tidak stabil | Probe di M0, fallback action envelope JSON. |
| Stiker tidak pantas masuk koleksi | GLM wajib skip NSFW/SARA/merendahkan, dan owner bisa `/stiker buang`. Semua keputusan tercatat. |
| Stiker wajah member tersebar ke grup lain | Scope `local` ditetapkan GLM saat kurasi. Kalau GLM ragu, default-nya `local`. |
| Grad jadi spam stiker | Jeda per stiker sesuai `planned_frequency` dan batas stiker per jam per grup. |
| Biaya kurasi multimodal | Hanya sekali sehari, batch ~10, dan stiker yang sama tidak dinilai ulang tanpa alasan. |
| Prompt injection dari halaman web | Hasil tool diberi label data tak tepercaya. Tidak ada tool yang mengirim ke luar chat asal, jadi dampaknya terbatas. |
| Rilis langsung ke semua grup | Kill switch `/agent off`, dan rollback via git + restart tmux. |
| Loop dan balasan biasa jadi lebih lambat | Jev tetap menyaring dulu. Obrolan biasa tanpa tool = satu panggilan GLM seperti sekarang. |

## 11. Yang sengaja tidak dikerjakan (sekarang)

- Eksekusi kode/Python sebelum M4b (sandbox Docker + toggle M2b wajib ada lebih dulu).
- Mengirim pesan ke chat lain atau membuat grup.
- Multi-agent paralel / spesialis beda model, vector DB, MCP. (Subagent **tugas latar** sudah ada sejak 27 Sep 2026.)
