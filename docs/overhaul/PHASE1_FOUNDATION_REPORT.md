# Laporan Implementasi Fase 1 — Fondasi, Koreksi Final & Stabilisasi Paralel

**Tanggal**: 22 September 2026  
**Status**: Selesai & Terverifikasi Penuh (115/115 Test Lulus Stabil, 5 Run Berturut-turut Tanpa Flake)  
**Lingkup**: Fase 1 (Fondasi) — Tanpa SQLite runtime, autonomous loop Fase 3, tools media/web Fase 4, deployment, commit, push, atau restart bot.

---

## 1. Koreksi Terhadap `BASELINE_AGENT_OVERHAUL.md`

Sebelum implementasi teknis dimulai, dokumen [BASELINE_AGENT_OVERHAUL.md](./BASELINE_AGENT_OVERHAUL.md) telah dikoreksi pada 4 aspek utama:
1. **Kegagalan Pemrosesan Video**: Dikoreksi agar tidak menyatakan bahwa semua video pasti membuat bot gagal. Dijelaskan bahwa kegagalan terjadi bila payload video diteruskan ke GLM sebagai base64 `video_url` pada jalur reply/generation jika provider backend tidak mendukung tipe data URL tersebut.
2. **Ekstraksi Frame/Thumbnail**: Ditegaskan bahwa ekstraksi 1 frame/thumbnail hanya menghasilkan representasi gambar statis tunggal dan bukan pemahaman menyeluruh terhadap konten video yang bergerak.
3. **Chain-of-Thought (CoT) & Reasoning**: Ditegaskan bahwa CoT/reasoning mentah tidak boleh disimpan sebagai artefak, dicetak ke log, atau dijadikan dependensi sistem. Yang direkam hanyalah metadata penggunaan token dan ringkasan keputusan terstruktur yang aman.
4. **Validitas Bukti Probe vs Katalog**: Ditegaskan pemisahan antara bukti empiris yang diperoleh dari probing langsung runtime dengan metadata katalog/model endpoint OpenRouter.

---

## 2. Ringkasan Fondasi Arsitektur & Koreksi Final

### 2.1. OpenRouter Client Bersama (`ai/providers/openrouter-client.js`)
- Memusatkan konfigurasi `baseURL`, proxy (via `OPENROUTER_PROXY_URL`), timeout, dan default headers (`HTTP-Referer`, `X-Title`).
- **Secret Handling & Encapsulation**: API key disimpan secara internal dalam closure dan **tidak diekspos sebagai properti publik** pada objek client.
- **Sanitasi Error Publik**: `OpenRouterError` membersihkan `cause` dan metadata agar `JSON.stringify(error)` maupun `JSON.stringify(client)` tidak pernah membocorkan token Authorization, API key, atau data URL base64.
- **Error classification**: Mengklasifikasikan respons error menjadi 6 kategori diskret: `timeout`, `rate_limit`, `provider_error`, `invalid_request`, `unsupported_capability`, dan `malformed_response`.
- **Decoupled Retry Hook Terhubung ke Budget**:
  - Menyediakan callback/hook `onRetry({ attempt, category, endpoint, error })` tanpa mengikat client secara langsung ke `TaskBudget`.
  - Adapter/runtime memberikan `onRetry` yang memanggil `budget.recordRetry()`.
  - Retry dibatasi secara ketat maksimal tepat 2 retry (`attempt < maxRetries`). Bila `recordRetry()` menolak karena kuota retries habis, proses retry langsung dihentikan dan melempar error budget.
  - Error non-transient (`invalid_request`, `unsupported_capability`) tidak pernah di-retry.

### 2.2. Adapter Jev (`ai/providers/jev-client.js`)
- Menggunakan endpoint `/api/alpha/decisions`.
- Memvalidasi struktur respons: memverifikasi bahwa jawaban (`choice`) yang diberikan model benar-benar terdaftar dalam opsi caller. Pilihan yang tidak sah ditolak dengan pesan terstruktur.
- Menegaskan bahwa nilai `confidence` dan `probabilities` hanya merupakan probabilitas statistik dan **bukan otorisasi akses**.
- Mempertahankan format `sessionId` (`wa-<groupId>`), parsing probabilitas, dan integrasi mulus dengan `group-agent.js` serta `direct-agent.js`.

### 2.3. Adapter GLM (`ai/providers/glm-client.js`)
- Mendukung mode chat completions standar, *strict JSON Schema structured outputs*, dan *native tool calling*.
- **Tool-Call Safety**: Memvalidasi setiap `tool_call` secara terstruktur: ID non-empty, function name non-empty, dan argumen wajib berupa plain JSON object (bukan string mentah, bukan array, bukan primitif). Tool call yang rusak ditandai `ok: false` dengan pesan error terstruktur dan tidak dieksekusi.
- `rawArguments` tidak disimpan dalam output publik/trace untuk mencegah kebocoran data mentah.
- Normalisasi output: mengembalikan object standar berisi `{ text, toolCalls, finishReason, usage, provider, model, cost, latencyMs }`.
- Menjaga batasan `reasoningEffort: low` / `exclude: true` secara default dan tidak menyimpan/menampilkan reasoning mentah.
- Adapter tidak mengeksekusi tool (eksekusi tetap berada di ranah capability executor/runtime).

### 2.4. Schema Validation Berbasis Ajv (`ai/capabilities/registry.js`)
- Menggunakan pustaka standar industri `ajv` (`^8.20.0`) dalam **strict mode** (`strict: true`).
- Schema dikompilasi pada saat registrasi capability (`registry.registerCapability(...)`), bukan pada setiap pemanggilan runtime.
- Menolak argumen yang memuat `additionalProperties` ketika schema capability melarangnya.
- Pesan error disanitasi: error log tidak memuat data rahasia; error untuk model hanya memuat informasi esensial agar model dapat memperbaiki argumen JSON.
- Bebas dari penggunaan fungsi berbahaya seperti `eval` atau `new Function`.

### 2.5. Capability Registry Tunggal & Factory (`ai/capabilities/registry.js`)
- Menjadi *single source of truth* untuk seluruh capability dalam sistem.
- Menyediakan `createCapabilityRegistry()` factory untuk membuat instance terisolasi pada pengujian. Default instance `defaultRegistry` disediakan untuk production dalam kondisi bersih (**tidak ada test capabilities terdaftar otomatis**).
- Menegakkan kontrak ketat:
  - `name`, `version`, `description`, `inputSchema`, `outputSchema`
  - `risk`: `low` | `medium` | `high` | `critical`
  - `channelScopes`: pilihan channel (one-of: `group`, `dm`)
  - `requiredScopes`: izin wajib (all-of: `active_chat`, `read`, `write`, `send`, `schedule`, `owner`)
  - `enabled`: boolean (default: `false`)
  - `timeoutMs`: integer
  - `handler`: function
  - `verifier`: function (wajib mengembalikan bentuk eksplisit `{ ok: boolean, evidence?, error? }`)
  - `sideEffect`: `none` | `read` | `write` | `send` | `external`
  - `idempotency`: `read_only` | `idempotent` | `transactional` | `non_idempotent`
- Menegakkan aturan kombinasi enum yang valid:
  - `read_only` dilarang memiliki sideEffect `write`, `send`, atau `external`.
  - `send` atau `external` **wajib** memakai idempotency `transactional` atau `idempotent`; `non_idempotent` ditolak saat registrasi.
- `getToolDeclarations` menyelaraskan filter dengan policy: hanya mengekspos tool yang enabled dan memenuhi channel & required scopes.

### 2.6. Policy, Scopes, dan Anti-Injection (`ai/policy/scopes.js`, `ai/policy/authorize.js`)
- Mendefinisikan scope operasional: `group`, `dm`, `owner`, `active_chat`, `read`, `write`, `send`, `schedule`.
- **Actor Verification Fail-Closed**:
  - `actor.verified` wajib bernilai tepat boolean `true`. Nilai `undefined`, `null`, `false`, angka, atau string truthy langsung ditolak (`DENIED_UNVERIFIED_ACTOR`).
  - Memvalidasi `actor.provenance` terhadap allowlist runtime (`runtime_inbound_message`, `runtime_internal_task`, `runtime_scheduler`, `test_harness`).
  - Menolak raw WhatsApp LID (`@lid`), nomor telepon kosong, dan actor tidak dikenal.
- **Pemisahan Semantik Scope**:
  - `channelScopes`: diperiksa dengan aturan *one-of* terhadap active channel.
  - `requiredScopes`: diperiksa dengan aturan *all-of* terhadap active scopes.
  - `owner`: merupakan syarat eksplisit (`actor.isOwner === true`).
- **Larangan Keras Model Injection & Perlindungan Destinasi**:
  - Model dilarang menentukan destinasi (`destination`, `target`, `recipient`, `to`) pada argumen tool `send`, bahkan bila nilainya sama dengan origin chat (`destination_injection_denied`).
  - Model dilarang menentukan `idempotencyKey` / `idempotency_key` pada argumen (`invalid_idempotency_key`).
  - Menolak manipulasi argumen lintas obrolan (`DENIED_CROSS_CHAT`) dan melarang broadcast/wildcard (`DENIED_BROADCAST_WILDCARD`).

### 2.7. Pipeline Eksekusi Terpadu (`executeCapability`)
Urutan pipa eksekusi:
1. `resolve registered capability`
2. `enabled check`
3. `model injection guard` (tolak `idempotencyKey` dan destinasi yang berasal dari model)
4. `input schema validation` (Ajv strict mode)
5. `authorize` (memanggil policy `authorize(...)`)
6. `sideEffect runtime preconditions`:
   - Untuk `write`, `send`, `external`: `context.originChatId` wajib non-empty.
   - `context.idempotencyKey` wajib non-empty, dibentuk oleh runtime, dan terikat pada `taskId`/`correlationId` atau prefix runtime.
   - Khusus `send`: tujuan hanya boleh dari runtime dan wajib sama persis dengan `originChatId`.
7. `budget reservation` (`budget.reserve({ type: "tool" })`)
8. `execute handler with cancellation race` (`Promise.race([handlerPromise, timeoutPromise, cancellationPromise])`)
9. `output schema validation`
10. `verifier` (memverifikasi format `{ ok: boolean, evidence?, error? }`)
11. `budget reconciliation` (`budget.reconcile(reservationId)`)
12. `normalized observation` (`{ ok: true, data, evidence }`)

### 2.8. Aturan Akuntansi Percobaan Tool (Attempt Accounting)
- **Penolakan sebelum handler** (gate 1–7: schema error, policy denied, capability disabled, missing origin/idempotency, budget exhausted):
  - Memanggil `budget.release(reservationId)` jika ada reservasi.
  - Percobaan yang ditolak sebelum handler **TIDAK** dihitung sebagai tool step.
- **Setelah handler dimulai**:
  - Setiap eksekusi handler yang benar-benar mulai berjalan, terlepas dari hasil (sukses, error/exception, timeout, atau cancellation), **tetap dihitung sebagai 1 tool step** melalui `budget.reconcile(reservationId)`.
  - Kegagalan berulang tidak dapat menghindari `maxToolSteps`: 8 kegagalan menghabiskan kuota, dan eksekusi ke-9 ditolak sebelum handler (`budget_exhausted`).
  - Tool lokal tidak dikenakan token/cost model.

### 2.9. Cancellation Race & Pembersihan Sumber Daya
- **Cancellation Race**:
  - Dibuat `cancellationPromise` yang me-reject jika parent signal meng-abort setelah eksekusi dimulai.
  - `Promise.race` mencakup `handlerPromise`, `timeoutPromise`, dan `cancellationPromise`.
  - Eksekusi JavaScript non-cooperative tidak dapat dihentikan paksa di level runtime engine, namun hasil handler yang datang terlambat setelah cancel/timeout **diabaikan sepenuhnya**, tidak disimpan, dan verifier tidak dipanggil.
- **Pembersihan Bersih (Cleanup)**:
  - Event listener pada parent signal dicabut di blok `finally`.
  - Timer timeout selalu di-`clearTimeout` di `finally`.
  - Reservasi anggaran selalu direkonsiliasi atau dilepas sehingga tidak pernah bocor.
- **Observability Error**:
  - `createObservationError` membedakan secara diskret status `failed`, `timeout`, dan `cancelled`.
  - Error `cause` disanitasi agar tidak memasukkan objek Error mentah dengan stack trace atau secret.

---

## 3. Rincian File yang Diubah dan Ditambahkan

| File | Status | Keterangan |
|---|---|---|
| `BASELINE_AGENT_OVERHAUL.md` | Diubah | Koreksi 4 poin: video fail-soft, representasi thumbnail, penghapusan CoT mentah, pemisahan bukti probe vs katalog. |
| `package.json` & `package-lock.json` | Diubah | Menambahkan dependensi `ajv` (`^8.20.0`) dan mendaftarkan `test/foundation.test.js` ke script `npm test`. |
| `ai/providers/openrouter-client.js` | Diubah | Central client OpenRouter: apiKey disembunyikan dalam closure, sanitasi error cause, hook `onRetry` terhubung ke TaskBudget, batas ketat maksimal 2 retries, non-retryable invalid_request. |
| `ai/providers/jev-client.js` | Diubah | Adapter Jev: `/api/alpha/decisions`, validasi choice terhadap caller criteria, sessionId preservation, normalized response. |
| `ai/providers/glm-client.js` | Diubah | Adapter GLM: chat completion, strict schema output, validasi tool calls (ID, name, JSON object args), video fail-soft conversion. |
| `ai/capabilities/registry.js` | Diubah | Pipeline 12-tahap: deteksi injeksi model, policy authorize, prakondisi originChatId & runtime idempotencyKey, cancellation race (`cancellationPromise`), attempt counting via reconcile on failure, sanitasi cause, `createObservationError`. |
| `ai/policy/scopes.js` | Diubah | Pemisahan tegas `CHANNEL_SCOPES` (one-of) dan `PERMISSION_SCOPES` (all-of). |
| `ai/policy/authorize.js` | Diubah | Fail-closed actor verification (`verified === true`), validasi provenance, penegakan channelScopes & requiredScopes all-of, owner explicit check, penolakan argumen target model (`destination`/`target`/`recipient`/`to`). |
| `ai/runtime/budget.js` | Diubah | Aligned limits per Plan.md (8 tools, 12 models, 2 retries, 180s wall time, 16k tokens, $0.05 cost), metode `recordRetry()`, `reconcile()` untuk failure accounting, dan `release()` untuk pre-handler abort. |
| `ai/observability/redact.js` | **Baru** | Filter pembersih secret, API key, token Authorization, data URL, dan base64 blob. |
| `ai/observability/trace.js` | **Baru** | Structured event tracer dengan in-memory sink dan pembuangan CoT mentah. |
| `scripts/simulator-setup.js` | **Baru** | Helper isolasi simulator: mkdtemp, env redirection, dan production file safety guard. |
| `scripts/simulate-ai.js` | Diubah | Menggunakan `simulator-setup` sebelum AI modul dan `dotenv`, cleanup di blok `finally`. |
| `scripts/simulate-burst.js` | Diubah | Menggunakan `simulator-setup` sebelum AI modul dan `dotenv`, cleanup di blok `finally`. |
| `scripts/simulate-dm.js` | Diubah | Menggunakan `simulator-setup` sebelum AI modul dan `dotenv`, cleanup di blok `finally`. |
| `scripts/simulate-memory.js` | Diubah | Menggunakan `simulator-setup` sebelum AI modul dan `dotenv`, cleanup di blok `finally`. |
| `ai/group-agent.js` | Diubah | Migrasi ke `createJevClient` dan `createGlmClient`, prompt metadata video jujur, mempertahankan invariant WhatsApp. |
| `ai/direct-agent.js` | Diubah | Migrasi ke client baru, prompt reminder fokus tanpa menyeret topik lalu, larangan emoji berlebih, whitelist DM & anti-broadcast terjaga. |
| `test/ai.test.js` | Diubah | Menambahkan penyesuaian mock server untuk flag `AI_PROVIDER_SUPPORTS_VIDEO` agar kompatibilitas tes legacy terjaga. |
| `test/foundation.test.js` | **Baru** | Suite tes komprehensif 110 tes mencakup seluruh koreksi A–D (cancellation race, attempt counting, retry budget hook, idempotency/origin preconditions). |

---

## 4. Hasil Verifikasi dan Pengujian

### 4.1. Sintaksis Kode (`node --check`)
```bash
node --check index.js ai/capabilities/registry.js ai/direct-agent.js ai/group-agent.js ai/observability/redact.js ai/observability/trace.js ai/policy/authorize.js ai/policy/scopes.js ai/providers/glm-client.js ai/providers/jev-client.js ai/providers/openrouter-client.js ai/runtime/budget.js scripts/simulate-ai.js scripts/simulate-burst.js scripts/simulate-dm.js scripts/simulate-memory.js scripts/simulator-setup.js test/ai.test.js test/foundation.test.js
```
**Hasil**: Seluruh file lulus 100% tanpa kesalahan sintaks.

### 4.2. Unit & Integration Test Suite (`npm test`)
Dijalankan melalui perintah default `node --test test/bot.test.js test/ai.test.js test/agent.test.js test/foundation.test.js`:
- **Total Test**: **115 tes**
- **Lulus**: **115 tes** (100% pass)
- **Gagal**: 0
- **Dibatalkan/Skip**: 0

### 4.3. Audit Dependensi (`npm audit --omit=dev`)
```bash
npm audit --omit=dev
```
**Hasil**: `found 0 vulnerabilities`.

### 4.4. Verifikasi Integritas File Produksi (SHA-256)
Pemeriksaan hash SHA-256 dijalankan sebelum dan sesudah seluruh pengujian dan simulasi API live:
- `ai-memory.json`:
  - Hash: `76EAAECB50ED38EB927AEC1B8AD30E1F9A2B1E06EEDBDDB81CAC33AE423F955C`
  - Status: **TIDAK BERUBAH** (`MEMORY_UNCHANGED=True`)
- `agent-jobs.json`:
  - Hash: `B0D4C3B2E08DC120E6B058450B22CA19411C85C40929E64464348693F4E96050`
  - Status: **TIDAK BERUBAH** (`JOBS_UNCHANGED=True`)

### 4.5. Hasil Simulasi API Nyata Terhadap OpenRouter
1. **`npm run simulate:ai`**: **13/13 skenario lulus** (percakapan manusia, pertanyaan teknis, deteksi apresiasi bot vs anggota lain, panggilan nama bot).
2. **`npm run simulate:dm`**: **5/5 skenario lulus** (smalltalk, konsultasi, reminder tanpa mengungkit topik lama dan tanpa emoji berlebih, penolakan broadcast, penanganan opt-out). Gaya konfirmasi reminder terbukti fokus dan tidak menyeret topik resign.

---

## 5. Laporan Kegagalan Independen (109/110) & Analisis Akar Masalah

Pada saat verifikasi independen pertama kali dijalankan, `npm test` memperoleh hasil **109/110 lulus (1 tes gagal)**:
- **Test yang gagal**: `Point J: Balasan konfirmasi reminder di chat pribadi fokus hanya pada reminder`
- **Error aktual**:
  ```text
  ENOENT: no such file or directory, rename 'D:\EXPERIMENT\A\test\ai-memory-agent.json.tmp' -> 'D:\EXPERIMENT\A\test\ai-memory-agent.json'
  ```

### 5.1. Akar Masalah (Root Cause)
1. **Konkurensi Berkas Bersama Antar-Proses Paralel**:
   - `node --test` mengeksekusi 4 berkas test (`test/bot.test.js`, `test/ai.test.js`, `test/agent.test.js`, `test/foundation.test.js`) secara paralel dalam proses/worker terpisah.
   - `test/agent.test.js` dan `test/foundation.test.js` sama-sama mengarahkan variabel lingkungan `process.env.AI_MEMORY_FILE` ke `./test/ai-memory-agent.json` dan `process.env.AGENT_JOBS_FILE` ke `./test/agent-jobs.json`.
   - `test/ai.test.js` tidak menyetel environment file sehingga menggunakan file default root `./ai-memory.json`.
   - `test/bot.test.js` menggunakan `./test/ai-memory.json` dan `./test/data.json`.
2. **Nama Berkas Temporer Statis pada `save()`**:
   - `ai/memory-store.js` dan `ai/scheduler.js` menggunakan nama berkas temporer statis `${MEMORY_FILE}.tmp`.
   - Ketika dua suite test paralel (`agent.test.js` dan `foundation.test.js`) sama-sama melakukan penulisan memori (`recordParticipant`, `upsertPersonProfile`, `resetAllMemory`), kedua proses berebut menulis dan me-rename file `.tmp` yang sama persis di sistem operasi Windows.
   - Proses A me-rename `.tmp` sementara Proses B baru akan melakukan rename atau baru selesai menulis, memicu `ENOENT` atau `EPERM`.
3. **Kelemahan Validasi Idempotency Sebelumnya**:
   - Registry sebelumnya menerima idempotency key hanya berdasarkan prefix longgar (`rt_`, `runtime_`, `idemp_`) atau jika key mengandung taskId sebagai substring (`includes(taskId)`).
   - Hal ini memungkinkan key palsu (`rt_fake`), substring sembarangan, atau key milik task lain lolos validasi tanpa verifikasi derivasi deterministik.

---

## 6. Solusi & Perbaikan Komprehensif

### 6.1. Isolasi Filesystem Total Setiap Test Suite (`test/helpers/test-env.js`)
- Dibuat helper isolasi `setupIsolatedTestEnv(prefix)` yang membuat direktori temporer unik OS via `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`.
- Menyetel variabel lingkungan berikut ke path unik di dalam folder temporer tersebut **sebelum modul aplikasi mana pun di-require**:
  - `process.env.AI_MEMORY_FILE = path.join(testDir, "ai-memory.json")`
  - `process.env.AGENT_JOBS_FILE = path.join(testDir, "agent-jobs.json")`
  - `process.env.BOT_DATA_FILE = path.join(testDir, "data.json")`
- Setiap berkas test (`bot.test.js`, `ai.test.js`, `agent.test.js`, `foundation.test.js`) mengisolasi jalurnya masing-masing dan membersihkan direktori temporernya sendiri melalui hook `test.after(...)` atau `cleanup()`.
- Menolak solusi kompromi concurrency=1 (`--test-concurrency=1`); pengujian default `npm test` dipertahankan sepenuhnya paralel dan stabil.
- Menghapus seluruh residu berkas JSON dari direktori `test/`.

### 6.2. Nama Berkas Sementara Unik & Retry Defensif
- Fungsi `save()` di `ai/memory-store.js` dan `ai/scheduler.js` diperbarui menggunakan nama berkas temporer berkode proses, timestamp, dan random entropy:
  ```javascript
  const temp = `${FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  ```
- Dilengkapi blok `try-catch` dengan retry jika terjadi *file lock* sesaat pada Windows (`EPERM`, `EBUSY`, `EACCES`), serta pembersihan file `.tmp` jika rename gagal.

### 6.3. Penguatan Validasi Idempotency Ketat & Deterministik
- **Menghapus Penerimaan Longgar**: Prefix `rt_`, `runtime_`, dan `idemp_` tidak lagi diterima otomatis.
- **Prakondisi Wajib**: Untuk side effect `write`, `send`, `external`:
  - `context.originChatId` wajib non-empty string.
  - `context.taskId` atau `context.correlationId` wajib non-empty string.
  - `context.logicalOperationId` atau `context.stepId` wajib non-empty string (runtime wajib mengirim operasi logis eksplisit).
  - `context.idempotencyKey` wajib non-empty string.
- **Helper Deterministik Tunggal**:
  - `buildIdempotencyKey({ taskId, capabilityName, logicalOperationId })`: menghitung SHA-256 dari `${taskId}:${capabilityName}:${logicalOperationId}` dan menghasilkan `idemp_<hash32>`.
  - `verifyIdempotencyKey(key, params)`: memvalidasi kecocokan exact terhadap hasil derivasi deterministik.
- **Proteksi Injeksi**:
  - `rt_fake` ditolak (`invalid_idempotency_key`).
  - Key yang memuat task ID hanya sebagai substring (misal `custom_${taskId}_extra`) ditolak.
  - Key milik task lain ditolak.
  - Model yang menyuntikkan `idempotencyKey` pada input arguments ditolak.
  - Exact runtime-generated key diterima dan dieksekusi dengan sukses.

### 6.4. Perbaikan Bug Cleanup & Cancellation
- **Pelepasan Abort Listener**: Listener `abort` pada parent signal selalu dilepas pada blok `finally` (terbukti `EventEmitter.listenerCount(signal, 'abort') === 0` pasca eksekusi).
- **Pencegahan Unhandled Rejection**: Promise handler dibungkus dan dipasangi `.catch(() => {})` agar handler yang menyelesaikan pekerjaan atau melempar error terlambat setelah timeout/cancellation tidak memicu `UnhandledPromiseRejection` pada Node.js.
- **Single Reconciliation Guarantee**: Seluruh rekonsiliasi budget diproteksi dengan guard `doReconcile`, memastikan budget hanya direkonsiliasi tepat 1 kali pada satu lifecycle eksekusi capability.

### 6.5. Penambahan Test Regresi (Poin K–O)
- `Point K`: Validasi deterministik dan konsistensi `buildIdempotencyKey` & `verifyIdempotencyKey`.
- `Point L`: Memastikan parent abort listener dilepas setelah `executeCapability` selesai.
- `Point M`: Memastikan handler terlambat yang melempar error tidak memicu `unhandledRejection`.
- `Point N`: Memastikan budget reconciliation dipanggil tepat 1 kali.
- `Point O`: Regression test mengeksekusi dua child process independen secara konkuren, masing-masing melakukan 30 siklus penulisan memori dan penjadwalan tanpa collision rename.

---

## 7. Bukti Lima Run Berturut-Turut Stabil Tanpa Flake

Perintah `npm test` dijalankan minimal 5 kali berturut-turut pada lingkungan paralel default Node.js. Hasil dari kelima run tersebut:

| Run | Total Test | Lulus | Gagal | Flake | Durasi | Status |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 115 | 115 | 0 | 0 | 2042 ms | **PASS** |
| **Run 2** | 115 | 115 | 0 | 0 | 2016 ms | **PASS** |
| **Run 3** | 115 | 115 | 0 | 0 | 2009 ms | **PASS** |
| **Run 4** | 115 | 115 | 0 | 0 | 2011 ms | **PASS** |
| **Run 5** | 115 | 115 | 0 | 0 | 2016 ms | **PASS** |

**Kesimpulan Stabilitas**: Seluruh 115 tes lulus 100% pada setiap run tanpa satupun kegagalan race condition atau flakiness.

---

## 8. Status Git dan Kerapian Kode

- `git diff --check`: Bersih (0 whitespace error, 0 conflict marker).
- `git status --short`:
```text
 M Plan.md
 M ai/capabilities/registry.js
 M ai/direct-agent.js
 M ai/group-agent.js
 M ai/memory-store.js
 M ai/scheduler.js
 M package-lock.json
 M package.json
 M scripts/simulate-ai.js
 M scripts/simulate-burst.js
 M scripts/simulate-dm.js
 M scripts/simulate-memory.js
 M test/agent.test.js
 M test/ai.test.js
 M test/bot.test.js
?? BASELINE_AGENT_OVERHAUL.md
?? PHASE1_FOUNDATION_REPORT.md
?? ai/observability/
?? ai/policy/
?? ai/providers/
?? ai/runtime/
?? scripts/simulator-setup.js
?? test/foundation.test.js
?? test/helpers/test-env.js
```
- Tidak ada commit, push, deploy, modifikasi kredensial `auth/`, ataupun restart bot.
- Koreksi final Fase 1 Fondasi telah tuntas dan terverifikasi secara penuh.
