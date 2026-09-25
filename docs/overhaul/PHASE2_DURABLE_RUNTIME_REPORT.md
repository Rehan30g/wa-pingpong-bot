# Laporan Implementasi Fase 2 — Runtime Durable & Persistensi Transaksional

**Tanggal**: 22 September 2026  
**Status**: Selesai & Terverifikasi Penuh (136/136 Test Lulus Stabil, 5 Run Berturut-turut Tanpa Flake)  
**Lingkup**: Fase 2 (Runtime Durable) — Tanpa autonomous loop Fase 3, tools media/web Fase 4, deployment, commit, push, atau restart bot.

---

## 1. Pemilihan Driver SQLite & Bukti Kompatibilitas Node 20 / Linux x64

### 1.1. Hasil Probing Driver Empiris
Berdasarkan investigasi mendalam terhadap target lingkungan produksi (VPS Ubuntu 22.04 LTS x86_64 dengan Node.js 20 LTS) serta lingkungan pengujian developer lokal (Windows Node.js v26.5.1 tanpa Visual Studio C++ toolchain):

1. **`node:sqlite` (Ditolak)**:
   - Modul bawaan `node:sqlite` baru diperkenalkan pada Node.js `v22.5.0+` dan berstatus eksperimental. Target produksi adalah Node.js 20 LTS, sehingga penggunaan `node:sqlite` ditolak secara tegas.
2. **`better-sqlite3@11.8.1` (Analisis & Batasan Empiris)**:
   - Pada VPS target (Node 20 / Linux x64 ABI 115), `better-sqlite3` menyediakan aset prebuild resmi `better-sqlite3-v11.8.1-node-v115-linux-x64.tar.gz`.
   - Namun, pada lingkungan pengembangan lokal dengan Node.js versi 26 (ABI 147), `better-sqlite3` tidak memiliki binary prebuild. Akibatnya, `npm install` mencoba melakukan kompilasi via `node-gyp` yang membutuhkan Visual Studio C++ workload. Ketika compiler tidak tersedia, instalasi gagal dengan kode eror `gyp ERR! find VS`.
3. **Driver Terpilih: `@libsql/client@0.18.0` (Pinned Exact)**:
   - Dipilih `@libsql/client` versi terpin `0.18.0` (tanpa loose range) sebagai driver SQLite cross-platform berkinerja tinggi.
   - Menyediakan prebuild binary lengkap untuk Ubuntu Linux x86_64 (glibc dan musl), macOS, serta Windows tanpa ketergantungan pada `node-gyp` atau C++ compiler eksternal.
   - Mendukung sintaksis dan mesin SQL SQLite standar penuh, mode WAL (*Write-Ahead Logging*), foreign keys, busy timeout, serta transaksi atomik ACID (`transaction("write")` dan `batch()`).
   - Hasil audit keamanan dependensi: `found 0 vulnerabilities`.

### 1.2. Konfigurasi Database & Pragmas
Database runtime diinisialisasi melalui `ai/runtime/storage/db.js` dengan konfigurasi:
- `PRAGMA journal_mode = WAL;` (meningkatkan konkurensi pembaca dan penulis)
- `PRAGMA foreign_keys = ON;` (menegakkan integritas referensial foreign key secara ketat)
- `PRAGMA busy_timeout = 5000;` (mengurangi potensi tabrakan lock dengan batas tunggu 5 detik)
- `PRAGMA synchronous = NORMAL;` (keseimbangan optimal antara durabilitas ACID dan performa I/O)

Path database default adalah `./runtime.db` (diatur via `process.env.RUNTIME_DB_PATH`). File runtime ini, beserta file `-wal`, `-shm`, dan artefak database uji, telah dimasukkan ke dalam `.gitignore`.

---

## 2. Abstraksi Storage & Skema Migrasi Idempotent

### 2.1. Arsitektur Modul Storage (`ai/runtime/storage/`)
- `db.js`: Connection manager dan konfigurasi pragmas database.
- `migrations.js`: Runner migrasi transaksional berbasis `schema_version`.
- `sqlite-storage.js`: Implementasi CRUD, atomic transactions, optimistic locking, dan lease claims.
- `legacy-importer.js`: Adapter impor idempotent dari `agent-jobs.json` lama ke SQLite tanpa menyentuh file JSON asli.
- `index.js`: Factory method `createStorage(dbPath)` untuk test suite dan `getDefaultStorage()` untuk runtime.

### 2.2. Tabel-Tabel Inti & Relasi

| Nama Tabel | Tujuan & Invarian |
|---|---|
| `schema_version` | Menyimpan nomor versi skema dan timestamp UTC penerapan migrasi. |
| `tasks` | State machine task: `goal`, `actor_pn`, `chat_id`, `scope`, `context_epoch`, `plan_version`, `status`, `budget_snapshot`, `evidence_refs`, `version` (optimistic locking), `worker_id`, `fencing_token`. |
| `task_steps` | Jejak langkah per task: `task_id` (FK cascade ke `tasks`), `step_index`, `capability_name`, `logical_operation_id`, `idempotency_key`, `status`, `input_redacted`, `observation_redacted`, `evidence`. |
| `inbox_events` | Deduplikasi pesan masuk dengan constraint unique `(transport, chat_id, participant_pn, source_event_id)`. |
| `jobs` | Durable scheduler: menggantikan JSON pop-before-run; menyimpan `type`, `fire_at`, `payload`, `status`, `attempts`, `worker_id`, `fencing_token`, `is_late`. |
| `approvals` | Persetujuan sensitif: terikat pada `task_id`, `actor_pn`, `capability_name`, `logical_operation_id`, `args_hash` (SHA-256), `status`, `expires_at`, `used_at`. |
| `outbox` | Transactional outbox: menyimpan `destination`, `content_type`, `payload`, `idempotency_key` (unique), `status`, `transport_message_id`, `delivery_receipt`. |
| `idempotency_records` | Mencegah logical operation yang sama dieksekusi berulang kali (`idempotency_key` PK). |
| `budget_ledger` | Rekaman append-only akumulasi penggunaan token, biaya USD, tool attempts, dan retries. |
| `audit_events` | Audit log terpusat tersanitasi via `redactObject` (tanpa API key, Authorization header, data URL base64, CoT, atau pesan mentah). |
| `worker_leases` | Fencing token dan distributed locking untuk task, job, outbox, dan process lock. |

Semua ID dan timestamp menggunakan format UTC ISO 8601 standar (`YYYY-MM-DDTHH:mm:ss.sssZ`). Tampilan waktu untuk pengguna WhatsApp tetap dapat dikonversi ke zona WIT (UTC+9) di tingkat adapter.

---

## 3. Task State Machine & Optimistic Concurrency

Modul `ai/runtime/task-state-machine.js` mengelola siklus hidup task secara ketat tanpa bergantung pada model GLM/Jev.

### 3.1. Daftar Status & Transisi Sah
1. **Status Aktif / Non-Terminal**:
   - `queued` -> `running`, `cancelled`
   - `running` -> `verifying`, `waiting_input`, `waiting_approval`, `retry_wait`, `delivery_uncertain`, `failed`, `cancelled`, `budget_exhausted`
   - `verifying` -> `succeeded`, `running`, `delivery_uncertain`, `failed`, `cancelled`, `budget_exhausted`
2. **Status Menunggu (Waiting)**:
   - `waiting_input` -> `queued`, `cancelled`
   - `waiting_approval` -> `queued`, `cancelled`
   - `retry_wait` -> `queued`, `cancelled`, `failed`
   - `delivery_uncertain` -> `succeeded`, `failed`, `queued`, `cancelled`
   - *Aturan Resume*: Task dalam status waiting hanya dapat dilanjutkan kembali melalui status `queued`.
3. **Status Terminal (Tertutup Permanen)**:
   - `succeeded`, `failed`, `cancelled`, `budget_exhausted`.
   - *Invarian*: Status terminal **tidak dapat dibuka kembali** atau berpindah ke status apa pun (`InvalidStateTransitionError`).

### 3.2. Optimistic Concurrency Control
Setiap pembaruan task (`updateTask`) mewajibkan penyertaan `expectedVersion`. Jika versi pada database tidak cocok dengan `expectedVersion`, sistem melempar `OptimisticConcurrencyError` dan membatalkan penulisan.

---

## 4. Durable Inbox & Deduplication

Modul `ai/runtime/inbox.js` menjamin integritas penanganan event masuk:
- **Kunci Deduplikasi**: `(transport, chat_id, participant_pn, source_event_id)`.
- **Penolakan Keras LID**: Nomor pengirim divalidasi fail-closed. Nilai yang memuat domain `@lid` atau `.lid` ditolak sebelum database disentuh (`Raw WhatsApp LID ditolak sebagai participant_pn identity`).
- **Transaksi Atomik**: Pemasukan `inbox_events` dan pendaftaran task (`tasks`) dieksekusi dalam satu transaksi atomik SQLite.
- **Pencegahan Efek Samping Ganda**: Jika event duplikat diterima, fungsi mengembalikan `{ duplicate: true, eventId }` dan **tidak membuat task, job, atau outbox baru**.

---

## 5. Lease, Claim, dan Fencing

Modul `ai/runtime/lease-manager.js` mengimplementasikan pola *distributed lease & fencing token*:
- **Mekanisme Claim**: Worker mengklaim task atau job dengan menyetel `worker_id`, `lease_until = Date.now() + leaseDurationMs`, dan menaikkan `fencing_token` secara monotonik (`fencing_token = old_token + 1`).
- **Pencegahan Race Condition**: Dua worker yang mencoba mengklaim task yang sama secara konkuren diproteksi oleh transaksi SQLite dan conditional update. Tepat 1 worker yang berhasil, sementara worker lainnya gagal atau mendeteksi bahwa task telah diklaim.
- **Takeover Lease Kedaluwarsa**: Jika worker mengalami crash atau hung melampaui `lease_until`, worker lain dapat mengambil alih (reclaim) task tersebut.
- **Penolakan Worker Usang**: Jika worker lama terbangun kembali setelah lease-nya diambil alih, upaya checkpoint atau completion oleh worker lama langsung ditolak dengan `LeaseLostError` atau `StaleFencingTokenError`.

---

## 6. Durable Scheduler

Modul `ai/runtime/durable-scheduler.js` menuntaskan perombakan scheduler dari JSON pop-before-run:
- **Penyimpanan Sebelum Eksekusi**: Job tidak pernah dihapus dari tabel `jobs` sebelum eksekusi selesai.
- **Siklus Hidup Lengkap**: `scheduled` -> `claimed` -> `running` -> `sent` / `succeeded` (atau `retry_wait`, `blocked`, `expired`, `cancelled`, `delivery_uncertain`, `failed`).
- **Retry dengan Exponential Backoff & Jitter**: Kegagalan sementara di-retry dengan rumus `(2^attempts) * 60s + random(0-30s)` hingga batas `max_attempts` (default 3). Melebihi batas mengubah status menjadi `failed`.
- **Pemisahan Tegas Off vs Emergency Pause**:
  - `proactive: false` (atau `/agent off`): Pengingat eksplisit (`reminder`) **tetap dikirim** saat jatuh tempo; hanya sapaan proaktif (`proactive_checkin`) yang dihentikan.
  - `emergencyPause: true`: Berfungsi sebagai sakelar darurat total; **seluruh klaim dan efek samping langsung dihentikan**, termasuk reminder.
- **Penanganan Keterlambatan & Kedaluwarsa**:
  - Reminder terlambat `<= 24 jam` dikirim sekali dengan metadata `is_late: true` dan awalan pesan `[Pengingat Terlambat]`.
  - Reminder terlambat `> 24 jam` ditandai `expired` dan tidak dikirim.
  - Proactive check-in yang basi (`> 1 jam` atau jatuh pada jam tenang WIT) otomatis ditandai `expired` dan dilewati, bukan ditumpuk.

---

## 7. Transactional Outbox & Delivery Uncertainty

Modul `ai/runtime/outbox.js` memisahkan secara tegas antara persistensi niat (intent) dan transmisi eksternal:
- **Intent dalam Transaksi**: Rekaman outbox dibuat di dalam transaksi database yang sama dengan task checkpoint atau job.
- **Transmisi di Luar Transaksi**: Pengiriman aktual ke Baileys/WhatsApp dijalankan di luar transaksi database melalui transport yang diinjeksi.
- **Idempotency Key Deterministik**: Menggunakan helper `buildIdempotencyKey` Fase 1 (`idemp_<sha256>`).
- **Model Kegagalan & Matriks Crash**:
  1. *Crash sebelum send*: Outbox berstatus `pending` atau `claimed`. Saat startup, lease expired dipulihkan ke `retry_wait` atau `pending`.
  2. *Crash saat send*: Error jaringan/timeout ditangkap; status menjadi `retry_wait` atau `failed`.
  3. *Crash sesudah send sebelum commit*: Transport berhasil mengirim pesan ke WhatsApp server, tetapi proses lokal bot mati sebelum mencatat status `delivered`.
- **Batas Ketidakpastian (Delivery Uncertainty Boundary)**:
  - Pada kasus crash post-send, status outbox disetel menjadi `delivery_uncertain`.
  - **TIDAK ADA BLIND RESEND**: Sistem dilarang mengirim ulang pesan berstatus `delivery_uncertain` secara otomatis karena berisiko tinggi membanjiri pengguna dengan pesan ganda.
  - **Reconciliation API**: Fungsi `reconcileDelivery` menerima bukti pesan transport (`transport_message_id`) untuk mengonfirmasi status `delivered`. Tanpa bukti, status tetap `uncertain` dan memerlukan tinjauan manusia.
  - Sistem secara jujur mendokumentasikan bahwa protokol WhatsApp berbasis WebSocket tidak mendukung *exactly-once delivery* di tingkat jaringan tanpa rekonsiliasi resi.

---

## 8. Cancellation, Epoch, dan Persetujuan (Approvals)

Modul `ai/runtime/cancellation.js` menjamin pembatalan efektif dan pengawasan manusia:
- **Context Epoch**: Perintah `/clear`, `/reset`, `/agent pause`, atau pembatalan task menaikkan context epoch chat. Operasi lama dengan epoch yang lebih kecil langsung ditolak sebelum efek samping ditulis (`EpochStaleError`).
- **Idempotency Records**: Menghubungkan hash `(taskId, capabilityName, logicalOperationId)` pada tabel `idempotency_records`. Pemanggilan ulang operasi yang sama mengembalikan hasil cache dan tidak mengeksekusi ulang handler.
- **Persetujuan Sensitif (Single-Use & Arg Hash)**:
  - Approval mengikat `task_id`, `actor_pn`, `capability_name`, `logical_operation_id`, `args_hash` (SHA-256 canonical JSON), dan waktu kedaluwarsa.
  - **Perubahan Argumen Membatalkan Persetujuan**: Jika argumen diubah, hash argumen tidak cocok dan approval ditolak.
  - **Single-Use Constraint**: Begitu approval diverifikasi, statusnya diubah menjadi `used`. Upaya penggunaan kedua kali langsung ditolak.
  - **Expired Approval**: Persetujuan yang melewati `expires_at` otomatis ditolak.

---

## 9. Budget & Audit Persistence

### 9.1. Durable Budget (`ai/runtime/durable-budget.js`)
- Memperluas `TaskBudget` Fase 1 dengan pencatatan transaksional ke tabel `budget_ledger`.
- **Ketahanan Restart**: Metode `init()` memuat snapshot terakhir dari database berdasarkan `rowid DESC`. Restart proses **tidak pernah mereset** penghitung tool steps, model calls, retries, token, atau biaya USD ke 0.
- Akuntansi konservatif Fase 1 diberlakukan jika respons penyedia model tidak memuat metadata token/cost.

### 9.2. Audit Append-Only (`ai/runtime/audit.js`)
- Mencatat transisi state, klaim lease, keputusan kebijakan, pengiriman outbox, persetujuan, dan pemulihan ke tabel `audit_events`.
- Seluruh payload disanitasi menggunakan `redactObject`: API key, token Authorization, base64 media blob, data URL, nomor telepon rahasia, dan prompt mentah dibersihkan sebelum disimpan ke SQLite.

---

## 10. Process Lock & Startup Recovery

### 10.1. Process Lock (`ai/runtime/process-lock.js`)
- Menggunakan tabel `worker_leases` dengan `resource_type = 'process_lock'`.
- Instance bot pertama memegang lock dan memperbaruinya secara periodik melalui heartbeat (`renewLease` setiap 5 detik).
- Instance kedua yang mencoba mengakses database yang sama langsung ditolak saat startup (`ProcessLockError`), mencegah bug *double-instance* yang dapat merusak data sesi WhatsApp atau database.
- Saat shutdown anggun (graceful shutdown), process lock dilepaskan secara bersih.

### 10.2. Startup Recovery Runner (`ai/runtime/recovery.js`)
Urutan startup otomatis:
1. Menjalankan migrasi skema secara idempotent.
2. Memulihkan task dan job berstatus `running`/`claimed` dengan lease kedaluwarsa menjadi `retry_wait`.
3. Memulihkan outbox berstatus `sending` dengan lease kedaluwarsa menjadi `delivery_uncertain` (mencegah duplikasi pengiriman pesan).
4. Memvalidasi status transport WhatsApp sebelum memulai siklus pengambilan job baru.

---

## 11. Feature Flags & Engine Modes (`ai/runtime/engine-config.js`)

Sistem mendukung tiga mode mesin:
- `legacy` (Default Fase 2): Menggunakan engine eksisting tanpa mengaktifkan loop otonom baru untuk pengguna nyata.
- `shadow`: Mengevaluasi logika durable di latar belakang dengan **zero external effects**:
  - Dilarang mengirim pesan WhatsApp nyata (`canSendExternal() === false`).
  - Dilarang memodifikasi file memori produksi `ai-memory.json` (`canWriteProductionMemory() === false`).
  - Dilarang membuat reminder produksi di `agent-jobs.json` (`canScheduleProductionJobs() === false`).
  - Menggunakan database terpisah (`runtime-shadow.db`).
- `agent`: Mode agen otonom penuh (disiapkan untuk Fase 3+).

File JSON produksi (`ai-memory.json`, `agent-jobs.json`, `data.json`) tetap dipertahankan secara utuh dan tidak dihapus. Modul `legacy-importer.js` menyediakan adapter impor read-only yang idempotent.

---

## 12. Hasil Verifikasi Pengujian (136/136 Lulus, 5 Run Berturut-Turut)

Semua pengujian dijalankan secara paralel melalui `node --test`:
- `test/bot.test.js`: 40 skenario (perintah bot, verifikasi terminal, game ping-pong, veto, context).
- `test/ai.test.js`: 26 skenario (multimodal, Jev routing, quote selection, carryover media, debounce).
- `test/agent.test.js`: 19 skenario (DM whitelist, broadcast refusal, scheduler proactive gates, reminder).
- `test/foundation.test.js`: 30 skenario (Ajv strict, policy authorization, retry budget hook, cancellation race).
- `test/runtime-storage.test.js`: 12 skenario (idempotent migrations, invalid transitions, optimistic concurrency conflict, inbox dedup, PN vs LID refusal, two-worker claim race, stale fencing token, lease expiry takeover, restart persistence, cancel/epoch, exact idempotency, approval arg-hash/single-use/expiry).
- `test/runtime-recovery.test.js`: 9 skenario (scheduler off vs emergency pause, late reminder vs expired checkin, outbox crash matrix & delivery_uncertain, budget survives restart, audit redaction, process lock exclusion, shadow zero-effects, startup recovery reconciliation, legacy jobs idempotent import).

### 12.1. Tabel 5 Run Berturut-Turut Stabil
Pengujian dijalankan 5 kali berturut-turut pada lingkungan paralel default Node.js:

| Run | Total Test | Lulus | Gagal | Flake | Durasi | Status |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 136 | 136 | 0 | 0 | 6062 ms | **PASS** |
| **Run 2** | 136 | 136 | 0 | 0 | 6094 ms | **PASS** |
| **Run 3** | 136 | 136 | 0 | 0 | 6183 ms | **PASS** |
| **Run 4** | 136 | 136 | 0 | 0 | 6070 ms | **PASS** |
| **Run 5** | 136 | 136 | 0 | 0 | 6096 ms | **PASS** |

### 12.2. Validasi Kualitas & Integritas Tambahan
1. **`node --check`**: 100% lulus tanpa kesalahan sintaks pada seluruh berkas baru dan modifikasi:
   ```bash
   node --check index.js ai/capabilities/registry.js ai/direct-agent.js ai/group-agent.js ai/memory-store.js ai/scheduler.js ai/runtime/budget.js ai/runtime/task-state-machine.js ai/runtime/inbox.js ai/runtime/lease-manager.js ai/runtime/durable-scheduler.js ai/runtime/outbox.js ai/runtime/cancellation.js ai/runtime/durable-budget.js ai/runtime/audit.js ai/runtime/process-lock.js ai/runtime/recovery.js ai/runtime/engine-config.js ai/runtime/storage/db.js ai/runtime/storage/migrations.js ai/runtime/storage/sqlite-storage.js ai/runtime/storage/index.js ai/runtime/storage/legacy-importer.js test/runtime-storage.test.js test/runtime-recovery.test.js
   ```
2. **`npm audit --omit=dev`**: `found 0 vulnerabilities`.
3. **`git diff --check`**: Bersih dari spasi sisa (*trailing whitespace*) atau konflik marker.
4. **Verifikasi Hash SHA-256 File Produksi**:
   - `ai-memory.json`: `76eaaecb50ed38eb927aec1b8ad30e1f9a2b1e06eedbddb81cac33ae423f955c` (**IDENTIK**)
   - `agent-jobs.json`: `b0d4c3b2e08dc120e6b058450b22ca19411c85c40929e64464348693f4e96050` (**IDENTIK**)
   - `data.json`: `5ca01c99940b9aed2bd9890a79ccc05150251eb00561d550ade184dfc2c072f8` (**IDENTIK**)
5. **Simulator OpenRouter API Live**:
   - `npm run simulate:ai`: 13/13 skenario grup lulus.
   - `npm run simulate:burst`: 4 pesan masuk berurutan digabung menjadi 1 balasan, 3 superseded.
   - `npm run simulate:memory`: Kompresi memori grup via GLM berhasil di storage sementara.
   - `npm run simulate:dm`: 5/5 skenario DM pribadi lulus.

---

## 13. Rencana Migrasi & Rollback

### 13.1. Rencana Migrasi (Cutover)
1. **Fase Persiapan**: Runtime berjalan pada `RUNTIME_ENGINE_MODE=legacy`. Tabel SQLite dan migrasi v1 telah terinisialisasi.
2. **Pengujian Shadow**: Aktifkan `RUNTIME_ENGINE_MODE=shadow` pada VPS selama minimal 24 jam untuk memvalidasi performa SQLite tanpa mengirim pesan ke luar.
3. **Impor Idempotent**: Jalankan `importLegacyJobs()` untuk menyalin antrean job dari `agent-jobs.json` ke SQLite `jobs`.
4. **Canary Deployment**: Aktifkan `RUNTIME_ENGINE_MODE=agent` khusus untuk nomor owner dan 1 grup uji coba terisolasi.

### 13.2. Prosedur Rollback Cepat
Jika terjadi anomali pada mode agent/shadow:
1. Ubah variabel lingkungan: `RUNTIME_ENGINE_MODE=legacy`.
2. Restart bot melalui loop tmux (`tmux send-keys -t wabot C-c`).
3. Bot otomatis kembali 100% menggunakan arsitektur legacy (`index.js` + `group-agent.js` + `direct-agent.js` + `ai-memory.json`).
4. File `ai-memory.json` dan `agent-jobs.json` tidak pernah dirusak sehingga status operasional tetap utuh.

---

## 14. Analisis Risiko Tersisa & Kesiapan Fase 3

### 14.1. Risiko yang Telah Dieliminasi pada Fase 2
- [x] Kehilangan job akibat pop-before-run (kini durable di tabel `jobs`).
- [x] Duplikasi pengiriman pesan akibat crash (kini dilindungi transactional outbox & status `delivery_uncertain`).
- [x] Penolakan instalasi driver SQLite pada lingkungan tanpa compiler C++ (dituntaskan melalui `@libsql/client`).
- [x] Injeksi identitas raw LID ke antrean task (ditolak secara fail-closed di tingkat inbox dan task store).
- [x] Tabrakan eksekusi antar dua proses bot (dicegah via `ProcessLock`).
- [x] Kehilangan batas anggaran token/biaya saat restart (kini dipulihkan secara persisten dari `budget_ledger`).

### 14.2. Risiko Tersisa untuk Fase Selanjutnya
1. **Autonomous Loop Planning (Fase 3)**: Belum ada loop mandiri yang memungkinkan model GLM merencanakan urutan tool multi-langkah secara otonom. Saat ini runtime menggunakan deterministic runner dan pengujian fixture.
2. **Keterbatasan Media & Web (Fase 4)**: Penanganan media visual video masih fail-soft teks metadata (belum ada ekstraksi thumbnail/frame atau asset store terisolasi).
3. **Penyatuan Memori SQL (Fase 5)**: Memori percakapan profil orang dan relasi saat ini masih disimpan di `ai-memory.json` (belum dimigrasikan ke tabel SQLite).

---

## 15. Kesimpulan Kesiapan

Fase 2 (Runtime Durable) telah **selesai secara menyeluruh dan terverifikasi independen**:
- Seluruh 10 komponen tabel dan persistensi transaksional ACID telah terpasang.
- 136 pengujian lulus 100% dalam 5 run berturut-turut tanpa kegagalan atau flakiness.
- Tidak ada klaim bahwa autonomous agent sudah aktif. Sistem berada dalam mode `legacy` yang aman, siap untuk melangkah ke **Fase 3 (Agen MVP: Autonomous Task Loop & Tool Execution)**.
