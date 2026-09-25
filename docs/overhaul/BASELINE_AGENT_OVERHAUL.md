# BASELINE_AGENT_OVERHAUL.md

**Tanggal Audit:** 22 September 2026  
**Status Evaluasi:** **READY WITH BLOCKERS**  
**Sasaran:** Baseline Fase 0 Overhaul Agen Otonom (Jev + GLM Flash) sesuai [Plan.md](file:///D:/EXPERIMENT/A/Plan.md) dan [AGENTS.md](file:///D:/EXPERIMENT/A/AGENTS.md)  
**Repository:** `D:\EXPERIMENT\A` (checkout lokal) / Target VPS: `/home/ubuntu/GITKARA2.1`

---

## 1. Environment Pemeriksaan dan Status Git

### 1.1 Environment Pemeriksaan
- **OS Lokal (Pemeriksaan Baseline & Probe):** Windows (Local Developer Environment)
- **Node.js Lokal:** `v26.5.1`
- **Target OS Produksi (VPS):** Ubuntu 22.04 LTS (x86_64), Node.js `v20` (NodeSource LTS), user `ubuntu`
- **Jaringan & Proxy:**
  - Lokal: Akses langsung ke OpenRouter API (`200 OK`, tanpa proxy Privoxy lokal).
  - VPS (Sesuai AGENTS.md): Request OpenRouter wajib melalui Privoxy (`http://127.0.0.1:8118`) -> WARP (`socks5://127.0.0.1:40000`). IP VPS direct diblokir 403 oleh Cloudflare OpenRouter.

### 1.2 Status Git & Worktree Awal
- **Branch:** `main`
- **Commit Terakhir:** `b18c835` (*Expand WhatsApp agent memory, DM, and media context*)
- **Status Worktree Awal:**
  - `Plan.md`: Terdeteksi modifikasi lokal sebelum sesi ini (spesifikasi overhaul terbaru).
  - `git diff --check`: Bersih (tidak ada trailing whitespace atau conflict marker).
  - Tidak ada commit atau push baru yang dilakukan selama Fase 0.

---

## 2. Arsitektur Aktual Sistem Saat Ini

| Modul | File | Peran & Implementasi Aktual | Keterbatasan / Sifat |
|---|---|---|---|
| **Entry & Event Adapter** | [`index.js`](file:///D:/EXPERIMENT/A/index.js) | Baileys socket, verifikasi owner terminal (`/verify`), ping-pong game, dispatch command modular, routing pesan ke AI group/DM. | Memegang state game (`games`), cache metadata grup, dan kode verifikasi dalam memori. |
| **Group Agent** | [`ai/group-agent.js`](file:///D:/EXPERIMENT/A/ai/group-agent.js) | Debounce pesan per grup, pemanggilan Jev (`/api/alpha/decisions`), auto-compact, pembuatan pesan multimodal ke GLM (`/api/v1/chat/completions`), reaction, typing presence, read receipt. | Riwayat aktif (`histories`), timer antrean (`pendingGroups`), rantai evaluasi (`evaluationChains`), dan epoch (`contextEpochs`) disimpan dalam `Map` di memori proses. |
| **Direct Agent (DM)** | [`ai/direct-agent.js`](file:///D:/EXPERIMENT/A/ai/direct-agent.js) | Chat pribadi 1-on-1, whitelist pengirim, pencegahan broadcast, opt-out/opt-in, reminder parser, delay natural & reply split. | Mengandalkan riwayat di `group-agent.js` dengan prefix `dm:`. Antrean dan epoch DM berada dalam memori proses (`Map`). |
| **Memory Store** | [`ai/memory-store.js`](file:///D:/EXPERIMENT/A/ai/memory-store.js) | Menyimpan data ke `ai-memory.json` (skema v2: `groups`, `people`, `relationships`, `settings`). Mengatur whitelist DM berdasarkan riwayat keaktifan di grup. | Menggunakan penyimpanan file JSON tunggal sinkron (`fs.writeFileSync`). Tidak ada isolasi provenance/ACL antara fakta yang dipelajari di grup vs DM. |
| **Scheduler** | [`ai/scheduler.js`](file:///D:/EXPERIMENT/A/ai/scheduler.js) | Menjadwalkan dan menjalankan job dari `agent-jobs.json`: `reminder`, `follow_up`, `proactive_checkin`. Mengatur kuota harian dan jam tenang WIT (22:00–07:00). | Menggunakan JSON tunggal. Mengeluarkan (pop) job dari file **sebelum** dieksekusi, sehingga rentan kehilangan job jika crash. Menghentikan reminder saat agen dimatikan. |
| **Humanize Helper** | [`ai/humanize.js`](file:///D:/EXPERIMENT/A/ai/humanize.js) | Jam tenang WIT (UTC+9), parsing waktu reminder natural ("15 menit lagi", "jam 8"), deteksi broadcast intent, pemecahan teks panjang, jitter delay. | Stateless helper murni. |
| **Capability Registry** | [`ai/capabilities/registry.js`](file:///D:/EXPERIMENT/A/ai/capabilities/registry.js) | Registrasi kapabilitas terisolasi dalam `Map`. | **Orphaned / Terisolasi:** Sama sekali belum diimpor atau dihubungkan ke loop eksekusi grup/DM. |

---

## 3. Hasil Pengujian Baseline (Commands & Tests)

Seluruh perintah baseline wajib dijalankan pada lingkungan lokal dengan hasil sebagai berikut:

| Perintah | Target | Hasil | Keterangan |
|---|---|---|---|
| `node --check index.js` | Sintaks bot & adapter Baileys | **PASS (0)** | Valid tanpa syntax error |
| `node --check ai/group-agent.js` | Sintaks AI group agent | **PASS (0)** | Valid tanpa syntax error |
| `node --check ai/direct-agent.js` | Sintaks AI direct agent | **PASS (0)** | Valid tanpa syntax error |
| `node --check ai/scheduler.js` | Sintaks scheduler agen | **PASS (0)** | Valid tanpa syntax error |
| `npm test` | Seluruh unit & integration test suite | **PASS (85/85)** | 85 passed, 0 failed, durasi ~7.5 detik |
| `npm audit --omit=dev` | Kerentanan dependensi produksi | **PASS (0)** | Ditemukan 0 kerentanan keamanan |
| `git diff --check` | Whitespace & merge markers | **PASS (0)** | Bersih, tidak ada trailing whitespace |

### Rincian Uji Unit `npm test` (85 skenario)
- **Modul Memory & Profile (v2 migration, person registry, whitelist, profile/relation isolation):** 4 skenario lulus.
- **Modul Humanize (broadcast intent, opt-out, reminder parsing, jam tenang, split reply):** 3 skenario lulus.
- **Modul Direct Agent (DM whitelist enforcement, DM reply low confidence, DM ignore on high confidence, anti-broadcast refusal, opt-out stopping proactive, DM history separation, media quoting):** 7 skenario lulus.
- **Modul Scheduler & Proactive (persistent on/off, proactive gates, reminder bypass proactive off, proactive check-in quota, blocked non-whitelist):** 5 skenario lulus.
- **Modul Group Agent Helpers (choiceConfidence, cleanReply, parseGeneratedReply, group history limit, compact consistency, bot mention detection, multimodal attachment, media limits):** 10 skenario lulus.
- **Modul Group Agent Integration (mock socket flow, video_url payload, sticker classification, quote selection, media carryover, read receipt & typing presence, identity differentiation by PN, debounce queue, superseded messages, bot dialogue continuation):** 16 skenario lulus.
- **Modul Bot Commands & Game (terminal verification code, wrong code rejection, expired code, /allow, /deny, ping-pong gameplay, scoring, /stop, /reboot, LID metadata alias, viewOnce wrappers, stream limits, /clear, /memory, /reset, veto system):** 40 skenario lulus.

---

## 4. Hasil Simulator API Nyata

Pengujian simulator dilakukan terhadap endpoint OpenRouter live dengan isolasi variabel lingkungan (`AI_MEMORY_FILE` dan `AGENT_JOBS_FILE` dialihkan ke path uji sementara agar tidak merusak data produksi `ai-memory.json` dan `agent-jobs.json`).

| Simulator | Model | Skenario | Hasil | Observasi & Kinerja |
|---|---|---|---|---|
| `npm run simulate:ai` | Jev 1.13 + GLM-5.3-Flash | 13 skenario grup | **13/13 Sukses** | - Obrolan manusia diabaikan (ignore 100%, DIAM).<br>- Pertanyaan langsung / mention dijawab (JAWAB reply).<br>- Ucapan terima kasih untuk bot diberi reaction (ack 👍 / heart ❤️).<br>- Terima kasih ke anggota lain diabaikan (ignore 100%, DIAM). |
| `npm run simulate:burst` | GLM-5.3-Flash | 4 pesan berturut-turut | **1/1 Sukses** | 3 pesan awal berstatus `superseded`, 1 pesan terakhir diproses menghasilkan 1 balasan tunggal yang akurat. Tidak ada duplicate responses. |
| `npm run simulate:memory` | GLM-5.3-Flash | Kompresi memori grup | **1/1 Sukses** | GLM menghasilkan output terstruktur JSON (`glm_memory`, `jev_context`, `people`, `relationships`). Memori lama dikompresi menjadi 6 pesan aktif tersisa. |
| `npm run simulate:dm` | Jev 1.13 + GLM-5.3-Flash | 5 skenario DM pribadi | **5/5 Sukses** | - Smalltalk dibalas ramah.<br>- Pertanyaan berat meminta klarifikasi.<br>- Permintaan reminder ("ingetin 30 menit lagi") dijadwalkan ke scheduler.<br>- Permintaan broadcast ditolak dengan template tetap.<br>- Permintaan "jangan chat aku dulu" mengaktifkan opt-out. |

---

## 5. Hasil Probe API Langsung & Metadata Katalog (Sanitized Evidence)

Pengujian probe independen dilakukan langsung ke OpenRouter API untuk memverifikasi kapabilitas model yang menjadi prasyarat desain Plan.md.

> [!NOTE]
> **Pembedaan Bukti Probe Empiris vs Metadata Katalog:**
> - **Bukti Probe Empiris (Didapat Langsung via Request Uji):** Format respons `/api/alpha/decisions`, validasi skema keputusan Jev, native tool calling GLM Flash dengan `get_current_weather`, transmisi gambar 1x1 base64 via `image_url`, penolakan video base64 via `video_url`, serta perilaku parameter reasoning.
> - **Metadata Katalog/Endpoint OpenRouter:** Batas panjang konteks (1,3M token), tabel harga resmi per token, dan daftar upstream providers aktif yang dilaporkan endpoint katalog model OpenRouter.

### 5.1 Jev (`typesafe/jev-1.13`)
- **Endpoint Aktif:** `https://openrouter.ai/api/alpha/decisions`
- **Model ID Aktual:** `typesafe/jev-1.13-20260917` (Provider: `TypeSafe`)
- **Struktur Respons (Bukti Probe Empiris):**
  ```json
  {
    "model": "typesafe/jev-1.13-20260917",
    "answers": {
      "action": {
        "type": "choice",
        "choice": "schedule",
        "probabilities": { "schedule": 0.95, "ignore": 0.02, "reply": 0.03 },
        "confidence": 0.94
      }
    },
    "usage": { "input_tokens": 367, "output_tokens": 38, "cost": 0.000015414 },
    "id": "gen-dec-1790082031-...",
    "provider": "TypeSafe"
  }
  ```
- **Karakteristik (Bukti Probe):**
  - Latency: ~718 ms.
  - Mengembalikan `choice`, `confidence`, serta distribusi probabilitas lengkap.
  - Validasi ketat pada schema pertanyaan: payload tanpa `questions` mengembalikan HTTP `400` dengan deskripsi tipe yang jelas (`expected record, received undefined`).

### 5.2 GLM 5.3 Flash (`z-ai/glm-5.3-flash`)
- **Endpoint Aktif:** `https://openrouter.ai/api/v1/chat/completions`
- **Canonical Model Slug (Metadata Katalog):** `z-ai/glm-5.3-flash-20260826`
- **Konteks Maksimal (Metadata Katalog):** 1.310.720 tokens (~1,3M tokens).
- **Harga Resmi OpenRouter (Metadata Katalog):** Prompt `$0.00000015`/token ($0.15/1M), Completion `$0.0000005`/token ($0.50/1M), Cache read `$0.00000005`/token ($0.05/1M).
- **Daftar Upstream Providers Aktif (Metadata Katalog):** Cloudflare, Z.AI (FP8), NextBit (FP8), Modal (FP8).
- **Native Tool Calling (Bukti Probe Empiris — VERIFIED):**
  - Probe mengirim deklarasi fungsi `get_current_weather` via parameter `tools` dan `tool_choice: "auto"`.
  - Respons mengembalikan `finish_reason: "tool_calls"`, `message.content: null`, dan `message.tool_calls` berisi ID pemanggilan dan argumen JSON `{"location":"Jakarta"}`.
  - Pengiriman balik hasil tool dengan peran `tool` (`tool_call_id`) pada giliran berikutnya berhasil menghasilkan jawaban akhir sintesis data tanpa eror.
- **Structured Outputs (Strict JSON Schema) (Bukti Probe Empiris — VERIFIED):**
  - Probe mengirim `response_format: { type: "json_schema", json_schema: { name: "task_envelope", strict: true, schema: { ... } } }`.
  - Respons mengembalikan JSON valid yang mematuhi enum `["tool_call", "ask_user", "final"]` dan properti wajib tanpa syntax error.
- **Parameter Reasoning (Bukti Probe Empiris):**
  - Model memiliki reasoning internal bawaan (default mandatory).
  - Parameter `reasoning: { effort: "low", exclude: false }` mengembalikan teks pertimbangan model pada field `message.reasoning`.
  - Parameter `reasoning: { effort: "low", exclude: true }` menyembunyikan CoT dan menghemat transmisi payload.
  - **Prinsip Keamanan & Privacy:** Dilarang menampilkan atau menyimpan chain-of-thought/reasoning mentah sebagai artefak, log, atau requirement. Yang disimpan oleh runtime hanya metadata penggunaan (token, biaya, latency) dan ringkasan keputusan yang aman. Default konfigurasi sistem wajib memakai `exclude: true`.
- **Multimodal Gambar (Image) (Bukti Probe Empiris — VERIFIED):**
  - Pengujian dengan gambar 1x1 piksel base64 data URI (`data:image/png;base64,...`) melalui `image_url` berhasil dianalisis oleh model dengan benar.
- **Multimodal Video (Video) (Bukti Probe Empiris — REJECTED ON BASE64 DATA URL):**
  - Pengujian dengan video base64 data URI (`data:video/mp4;base64,...`) melalui `video_url` ditolak dengan HTTP `400` / `422` oleh seluruh provider upstream OpenRouter.
  - Pesan penolakan upstream:
    - *Fireworks:* `"Video inputs must be provided as http(s) URLs; base64 data URLs are not supported for videos. Image inputs may still use base64 data URLs."`
    - *DigitalOcean:* `"At most 0 video(s) may be provided in one prompt. Set --limit-mm-per-prompt to increase this limit."`
    - *Wafer:* `"video input is temporarily not supported for this model"`
    - *Cloudflare / Modal / Inceptron:* `Could not decode video ... Failed to open input buffer: Invalid data found when processing input`.
  - **Klarifikasi Batasan & Dampak:** Tidak semua pesan video otomatis membuat bot gagal. Keputusan Jev berbasis teks tetap berjalan normal (menerima sinyal `has_video`). Eror HTTP 400 terjadi jika dan hanya jika video diteruskan ke GLM sebagai base64 `video_url`, biasanya ketika jalur balasan teks/generasi (`reply`) dijalankan. Bila Jev memutuskan `ignore` atau `react`, GLM tidak dipanggil dan alur bot tetap aman.


---

## 6. Audit Khusus & Analisis Risiko (P0 / P1 / P2)

### 6.1 Risiko P0 (Kritis — Integritas Data & Crash Resilience)
1. **Kehilangan Job Akibat Pop Sebelum Eksekusi:**
   - **Lokasi:** [`ai/scheduler.js:168-170`](file:///D:/EXPERIMENT/A/ai/scheduler.js#L168-L170)
   - **Mekanisme:** Fungsi `runDueJobs` menyaring job jatuh tempo (`due`), langsung menimpa file `agent-jobs.json` dengan `remaining`, dan menyimpan perubahan **sebelum** loop `runJob` selesai.
   - **Dampak:** Jika proses bot mati (crash, reboot, kill tmux, OOM) saat mengeksekusi salah satu job, seluruh job dalam daftar `due` yang belum selesai **hilang permanen**.
2. **Pembersihan Total Memori & Job oleh Simulator DM:**
   - **Lokasi:** [`scripts/simulate-dm.js:37-38`](file:///D:/EXPERIMENT/A/scripts/simulate-dm.js#L37-L38)
   - **Mekanisme:** Skrip `simulate-dm.js` memanggil `memoryStore.resetAllMemory()` dan `scheduler.clearJobs()`. Karena skrip tidak mengisolasi `process.env.AI_MEMORY_FILE` dan `process.env.AGENT_JOBS_FILE`, menjalankan `npm run simulate:dm` pada lingkungan produksi akan **menghapus bersih seluruh memori `ai-memory.json` dan antrean `agent-jobs.json`**.
3. **Penolakan Video Base64 pada Jalur Balasan GLM Flash:**
   - **Lokasi:** [`index.js:464`](file:///D:/EXPERIMENT/A/index.js#L464) dan [`ai/group-agent.js:481-483`](file:///D:/EXPERIMENT/A/ai/group-agent.js#L481-L483)
   - **Mekanisme:** Video dari chat dikonversi menjadi `data:video/mp4;base64,...` dan dikirim sebagai `video_url` ke OpenRouter. Probe membuktikan penyedia upstream menolak format ini dengan kode 400.
   - **Dampak Spesifik:** Error tidak terjadi pada semua video; jika Jev memutuskan `ignore` atau `react`, bot tidak mengalami error. Namun jika pesan memicu jalur reply/generasi teks dan video diteruskan sebagai `video_url` ke GLM, panggilan GLM gagal dengan status 400 dan memicu fallback error.
4. **Kontradiksi `/agent off` dengan Reminder Eksplisit:**
   - **Lokasi:** [`ai/scheduler.js:163-164, 229`](file:///D:/EXPERIMENT/A/ai/scheduler.js#L163-L164)
   - **Mekanisme:** `/agent off` memanggil `setEnabled(false)`, yang menghentikan interval timer `timer = null` dan membuat `runDueJobs` langsung keluar (`if (!cfg.enabled) return []`).
   - **Dampak:** Pengingat eksplisit yang diminta pengguna (reminder) tidak terkirim sama sekali saat mode agen dinonaktifkan, melanggar kontrak spesifikasi di AGENTS.md dan Plan.md.

### 6.2 Risiko P1 (Tinggi — Keandalan Arsitektur & Isolasi)
1. **Volatilitas State dalam Memori Proses:**
   - **Lokasi:** [`ai/group-agent.js:6-11`](file:///D:/EXPERIMENT/A/ai/group-agent.js#L6-L11), [`ai/direct-agent.js:6-9`](file:///D:/EXPERIMENT/A/ai/direct-agent.js#L6-L9), [`index.js:44`](file:///D:/EXPERIMENT/A/index.js#L44)
   - **Mekanisme:** Riwayat pesan (`histories`), antrean debounce (`pendingGroups`), rantai eksekusi (`evaluationChains`), dan epoch konteks (`contextEpochs`) seluruhnya bertumpu pada `Map` di RAM.
   - **Dampak:** Setiap kali bot di-restart via tmux loop, seluruh riwayat aktif belum terkompresi dan antrean in-flight hilang seketika. Epoch kembali ke 0.
2. **Ketiadaan Provenance & Kebocoran Memori Lintas Konteks (Grup vs DM):**
   - **Lokasi:** [`ai/memory-store.js:177-185`](file:///D:/EXPERIMENT/A/ai/memory-store.js#L177-L185), [`ai/direct-agent.js:531`](file:///D:/EXPERIMENT/A/ai/direct-agent.js#L531)
   - **Mekanisme:** `upsertPersonProfile` menggabungkan profil orang ke dalam satu entri global tanpa label kepemilikan/scope (`private_dm` vs `public_group`).
   - **Dampak:** Fakta sensitif yang dibagikan pengguna secara personal di DM dapat terinjeksi ke dalam profil yang kemudian dibaca dalam konteks grup atau sebaliknya.
3. **Ketiadaan Transaksional Outbox & Risiko Duplikasi Pesan:**
   - **Lokasi:** [`ai/scheduler.js:123-136, 178`](file:///D:/EXPERIMENT/A/ai/scheduler.js#L123-L136)
   - **Mekanisme:** `sock.sendMessage` dikirim langsung. Jika penulisan status berikutnya gagal, job di-push ulang dengan `fire_at + 5 menit`.
   - **Dampak:** Potensi pengiriman pesan ganda (duplicate delivery) ke pengguna WhatsApp.
4. **Ketidaktersediaan Built-in SQLite di Node.js 20 (Target VPS):**
   - **Lokasi:** Rencana migrasi database di Plan.md.
   - **Mekanisme:** Target VPS menjalankan Node.js 20 LTS. Modul native `node:sqlite` baru tersedia di Node.js 22.5.0+.
   - **Dampak:** Implementasi Fase 2 tidak dapat menggunakan `node:sqlite` secara langsung tanpa driver eksternal (misalnya `better-sqlite3`).

### 6.3 Risiko P2 (Menengah — Konsistensi Identitas & Kode Usang)
1. **Capability Registry Belum Terintegrasi:**
   - **Lokasi:** [`ai/capabilities/registry.js`](file:///D:/EXPERIMENT/A/ai/capabilities/registry.js)
   - **Mekanisme:** File registry ada namun tidak digunakan sama sekali dalam bot runtime.
2. **Normalisasi Angka Digit LID:**
   - **Lokasi:** [`ai/memory-store.js:30-34`](file:///D:/EXPERIMENT/A/ai/memory-store.js#L30-L34)
   - **Mekanisme:** `normalizePhone` hanya mengekstrak digit. Jika LID lolos ke scheduler atau payload, digit LID akan dianggap nomor telepon dan dikirimi pesan ke `<lid_digits>@s.whatsapp.net`.

---

## 7. Gap Analisis: Kondisi Saat Ini vs Target Plan.md

| Fitur / Komponen | Kondisi Eksisting | Persyaratan Plan.md | Status Gap |
|---|---|---|---|
| **Eksekusi Multi-Step** | Single-turn reply (Jev routing -> GLM string generator). | Autonomous loop: Goal -> Plan -> Tool Calling -> Observation -> Verify -> Terminal. | **Belum Ada** (Target Fase 2-3) |
| **Tool Calling Model** | Tidak ada pemanggilan tool runtime. | Native tool calling OpenRouter terintegrasi atau JSON envelope tervalidasi. | **Tervalidasi di API**, belum diimplementasikan di runtime |
| **Penyimpanan State** | File JSON flat (`ai-memory.json`, `agent-jobs.json`) + In-memory Map. | SQLite transaksional ACID (Task, Steps, Outbox, Lease, Epochs, Audit). | **Belum Ada** (Target Fase 2) |
| **Manajemen Izin & Policy** | Whitelist nomor sederhana dan flag admin boolean. | External policy validator, per-tool permissions, scope check, anti-SSRF. | **Belum Ada** (Target Fase 1) |
| **Durable Scheduler** | Interval timer di memori + JSON pop-before-run. | Durable claim lease, fencing token, retry backoff, rekonsiliasi outbox. | **Gap Kritis** (Harus dirombak di Fase 2) |
| **Pemisahan Off vs Pause** | `/agent off` mematikan semua scheduler termasuk reminder. | `/agent off` hanya mematikan proaktif; `/agent pause` untuk emergency stop total. | **Belum Ada** (Target Fase 1-2) |
| **Pelacakan Budget & Token** | Tidak ada pembatasan biaya atau pelacakan token runtime. | Ledger biaya USD/token per-task, tracking usage OpenRouter, batas langkah (8 tool steps, max 12 calls). | **Belum Ada** (Target Fase 1) |
| **Multimodal Video** | Mengirim base64 data URL ke GLM. | Mengakomodasi batasan upstream provider (metadata-only, frame extraction, atau hosted URL). | **Perlu Penyesuaian Desain** |

---

## 8. Keputusan Teknis yang Wajib Dibuat Sebelum Fase 1 & 2

1. **Pemilihan Driver SQLite untuk Node.js 20 di VPS:**
   - *Opsi A:* `better-sqlite3` (C++ native addon, sangat cepat, synchronous transactions, membutuhkan build tools/prebuild di Ubuntu 22.04).
   - *Opsi B:* `@libsql/client` atau pure JS/WASM SQLite (mudah dipasang tanpa native compilation, performa cukup untuk volume bot).
   - *Keputusan yang dibutuhkan:* Memilih driver yang aman dipasang tanpa merusak dependensi VPS Ubuntu 22.04.
2. **Penanganan Media Video pada GLM Flash:**
   - Karena OpenRouter menolak base64 data URL untuk video:
   - *Opsi A:* Ekstraksi 1 frame gambar (thumbnail) via Sharp / ffmpeg lalu kirim sebagai `image_url`. **Catatan krusial:** Ekstraksi satu thumbnail hanya memberikan representasi satu frame statis dan bukan pemahaman isi video penuh.
   - *Opsi B:* Fail-soft metadata jujur tanpa data URL biner: kirim sinyal metadata teks bahwa video terlampir namun isi visual belum dianalisis, tanpa mengklaim telah menonton video.
   - *Keputusan Fase 1:* Implementasikan Opsi B (fail-soft metadata jujur) sebagai fondasi yang aman tanpa upload/hosting publik. Ekstraksi thumbnail/frame ditunda ke Fase 4 (Media).
3. **Penyatuan Registry Kapabilitas:**
   - Mengganti atau merefaktor `ai/capabilities/registry.js` menjadi single source of truth untuk deklarasi schema fungsi, policy risk, dan tool handler.
4. **Isolasi Simulator:**
   - Memperbaiki `scripts/simulate-dm.js` dan `scripts/simulate-memory.js` agar secara default menggunakan file memory isolasi sementara, bukan menimpa data produksi.

---

## 9. Rekomendasi Scope dan Rencana Fase 1

Fase 1 sesuai Plan.md adalah **Fase Fondasi**. Berdasarkan temuan audit, ruang lingkup Fase 1 yang direkomendasikan adalah:

### Scope Utama Fase 1:
1. **Model Providers Adapter (`ai/providers/`):**
   - Adapter terisolasi untuk Jev (`/api/alpha/decisions`) dan GLM Flash (`/api/v1/chat/completions`).
   - Implementasi native tool calling interface dan JSON envelope fallback.
   - Ekstraksi token usage, metadata provider, dan biaya per pemanggilan.
2. **Schema Validator & Action Envelope:**
   - Validasi ketat terhadap input/output tool dan tindakan model (memastikan JSON rusak tidak pernah dieksekusi).
3. **Policy & Scopes Engine (`ai/policy/`):**
   - Validasi hak akses sebelum eksekusi tool.
   - Pencegahan broadcast dan perlindungan identitas PN vs LID.
4. **Budget & Cost Tracking (`ai/runtime/budget.js`):**
   - Pelacak batas langkah per-task (max 8 langkah tool, max 12 panggilan model).
   - Penegakan circuit breaker jika budget habis.
5. **Observability & Trace Redaction (`ai/observability/`):**
   - Sanitizer log untuk memastikan API key, token rahasia, auth WhatsApp, dan payload media tidak pernah bocor ke console.
6. **Perbaikan Keamanan Simulator:**
   - Pengalihan path file memory pada script simulasi ke folder temporer terisolasi.

### Daftar File yang Akan Dibuat / Dimodifikasi pada Fase 1:
- `[NEW]` `ai/providers/jev-client.js`
- `[NEW]` `ai/providers/glm-client.js`
- `[NEW]` `ai/providers/openrouter-client.js`
- `[NEW]` `ai/policy/authorize.js`
- `[NEW]` `ai/policy/scopes.js`
- `[NEW]` `ai/runtime/budget.js`
- `[NEW]` `ai/observability/trace.js`
- `[NEW]` `ai/observability/redact.js`
- `[NEW]` `test/foundation.test.js`
- `[MODIFY]` `ai/capabilities/registry.js` (delegasi ke schema terpadu)
- `[MODIFY]` `package.json` (penambahan skrip pengujian fondasi jika diperlukan)

---

## 10. Status Akhir Kesiapan

# **STATUS: READY WITH BLOCKERS**

### Ringkasan Penilaian:
- **Kesiapan Model & API:** **READY** — Jev dan GLM-5.3-Flash terbukti responsif, native tool calling teruji, dan JSON schema terbukti akurat.
- **Kesiapan Baseline Test:** **READY** — 85/85 test lulus, audit 0 vulnerabilities, syntax checks 100% lulus.
- **Blockers Kritis yang Harus Ditangani Sebelum/Pada Fase 1-2:**
  1. *Blocker Video Multimodal:* Desain transmisi video dialihkan ke fail-soft metadata jujur pada Fase 1 (tidak mengirim `data:video/...` sebagai `video_url` pada jalur balasan GLM).
  2. *Blocker Driver SQLite VPS:* Harus dipastikan driver SQLite yang kompatibel dengan Node.js 20 di VPS Ubuntu 22.04 sebelum masuk ke Fase 2.
  3. *Blocker Integritas Data Simulator:* Bahaya `simulate-dm.js` menimpa `ai-memory.json` produksi harus diisolasi sebelum pengetesan lanjutan.
  4. *Blocker Bug Scheduler:* Logika pop-before-run dan matinya reminder saat `/agent off` harus diperbaiki dalam rancangan engine baru.
