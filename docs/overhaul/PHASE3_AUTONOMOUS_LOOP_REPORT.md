# LAPORAN IMPLEMENTASI FASE 3: MVP AUTONOMOUS TASK LOOP (DENGAN KOREKSI PASCA-AUDIT)

> **Status Runtime**: Implementasi MVP Autonomous Task Loop Selesai, Terkoreksi, & Terverifikasi 100%.  
> **Konfigurasi Default**: `RUNTIME_ENGINE_MODE=legacy` (Tidak diubah, tetap default aman).  
> **Pernyataan Produksi**: Autonomous agent **TIDAK aktif** di environment production. Bot tetap berjalan dengan handler legacy secara default. Mode durable/agent hanya aktif di test harness / shadow canary berpagar (`ProcessLock` + transport readiness + canary allowlist).

---

## 1. Ringkasan Eksekutif & Tujuan Fase 3

Fase 3 membangun **Autonomous Task Loop** terstruktur di atas fondasi eksekusi model/capability Fase 1 dan storage/lifecycle Fase 2 (`ProcessLock`, `SQLiteStorage`, `LeaseManager`, `DurableBudget`, `OutboxManager`, `CancellationManager`).

Tujuan utama yang telah tercapai:
1. **Durable Task Runner & Worker**: Mengambil task berbasis lease + fencing token, memulihkan checkpoint saat restart, memecah goal menjadi langkah terikat (bounded), mengeksekusi langkah dengan checkpointing ketat, dan menyimpan status/hasil secara transaksional di SQLite.
2. **Planner GLM Flash Terstruktur**: Hanya beroperasi pada provider GLM Flash Fase 1 dengan skema JSON Ajv yang ketat (`strict: true`), batas langkah maksimal 8 langkah, pembersihan prompt terhadap rahasia, media mentah, dan auth header. Model **dilarang keras** dan **tidak memiliki kemampuan** untuk menginjeksi policy, approval status, actor identity, atau menulis ke basis data secara langsung.
3. **Capability Loop Berbasis Registry Fase 1**: Menggunakan registri kapabilitas terpadu Fase 1 tanpa jalur eksekusi paralel. Setiap langkah melalui tahapan: otorisasi actor (verified true, PN valid, provenance valid), verifikasi scope non-hardcoded, exact idempotency check, alokasi budget (`DurableBudget`), penegakan timeout (`AbortSignal`), penanganan persetujuan sensitif (`requiresApproval`), penolakan raw WhatsApp LID, dan penyensoran data sensitif (`AuditManager`).
4. **Outbox Guard & Canary Allowlist**: Semua efek keluar diarahkan melalui tabel `outbox` Fase 2. Mode agent wajib melewati `CanaryManager` (fail closed jika daftar kosong, hanya mengizinkan chat ID dan PN owner yang disetujui). Mode shadow hanya mencatat jejak audit dan simulasi outbox tanpa memodifikasi file produksi (`ai-memory.json`, `agent-jobs.json`) atau memanggil transport WhatsApp nyata.
5. **Deterministic Verifier**: Setiap hasil observasi diverifikasi terhadap skema output kapabilitas dan kriteria keberhasilan (*acceptance criteria*). Task hanya berakhir pada status terminal: `succeeded`, `failed`, `blocked`, `delivery_uncertain`, atau `cancelled`. Tidak ada status `running` yang menggantung tanpa lease aktif.

---

## 2. Arsitektur Komponen & Koreksi Pasca-Audit

```
Inbound Event (InboxManager)
    │
    ▼
Deduplikasi Event & Validasi PN/LID (Fail-Closed)
    │
    ▼
TaskStore (Tabel `tasks` SQLite: goal, actor_pn, chat_id, risk_level, provenance, epoch)
    │
    ▼
TaskRunner / Worker Loop
    │
    ├── 1. LeaseManager.claimTask(taskId) ──► Fencing Token Bump
    ├── 2. CancellationManager.verifyEpoch(chatId, epoch) ──► Cancel jika usang
    ├── 3. TaskPlanner (GLM Flash)
    │       ├── Sanitasi input (sensor secret/auth/media)
    │       ├── Validasi skema Ajv strict (max 8 steps, bounded schema)
    │       └── Tolak injeksi model (policy/identity/destination)
    ├── 4. Penyimpanan Rencana ke Tabel `task_steps` (Pending) + Checkpoint Awal (Preserve final_response)
    │
    └── 5. Step-by-Step Execution Loop (Satu Langkah Tiap Checkpoint):
            │
            ├── a. Assert Lease & Fencing Token
            ├── b. Exact Idempotency Check (skip jika sudah selesai)
            ├── c. Approval Check (cancellationManager.verifyAndConsumeApproval)
            │       └── Jika butuh approval: status -> waiting_approval, simpan checkpoint
            ├── d. Canary Allowlist Check (Agent Mode: fail closed jika kosong)
            ├── e. Budget Reservation (DurableBudget: maxToolSteps, retries, tokens, cost)
            ├── f. Dynamic Scope Derivation (deriveActiveScopes: tidak ada over-permission write)
            ├── g. Registry.executeCapability (Fase 1: timeout, abort signal race, scope check)
            ├── h. TaskVerifier.verifyStepResult (Ajv validation + error code contract)
            │       ├── Gagal & Retryable: DurableBudget.recordRetry -> status: retry_wait
            │       ├── Gagal & Exhausted: failTask (retry_budget_exhausted)
            │       └── Berhasil: status -> succeeded, catat idempotency & evidence
            └── i. Checkpoint Persisten (checkpointTask: version naik, lease diperpanjang)
    │
    ▼
6. Verifikasi Task Completion (TaskVerifier.verifyTaskCompletion)
    │
    ▼
7 & 8. Transaksi Atomik Penyelesaian Task (completeTaskWithOutboxIntent):
        ├── ensureOutboxIntent (idempoten: ON CONFLICT DO NOTHING / get-or-create)
        ├── Outbox intent memakai final_response GLM (atau fallback default jujur)
        ├── Refleksi status jujur (uncertain -> delivery_uncertain, cancelled -> cancelled)
        ├── Update terminal status task & rilis worker lease dalam 1 transaksi SQLite
        └── Jejak audit tersanitasi (tanpa CoT, tanpa secret, tanpa raw error cause)
```

---

## 3. Rincian Koreksi Audit Independen (Poin A - E)

### A. Outbox Completion Idempoten & Transaksi Atomik
- **Masalah Sebelum Koreksi**: Pembuatan intent outbox penyelesaian memanggil `createOutboxIntent` tanpa klausul idempotent/conflict handling dengan `logicalOperationId` tetap `final_task_completion_outbox`. Pada saat task yang sudah selesai dijalankan ulang (resume restart / duplicate claim), terjadi `SQLITE_CONSTRAINT: UNIQUE constraint failed: outbox.idempotency_key`, yang menyebabkan task ditandai `failed` (`internal_runner_error`) padahal seluruh langkah sudah `succeeded`.
- **Perbaikan yang Diterapkan**:
  1. Menambahkan dukungan idempoten get-or-create pada `SQLiteStorage.createOutboxIntent` dan `OutboxManager.createIntent` via opsi `idempotent: true` serta method eksplisit `ensureOutboxIntent`. Menggunakan pengecekan awal `getOutboxByIdempotencyKey`, klausul `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING;`, dan refetch record yang sah. Tidak menelan error secara buta.
  2. Mengimplementasikan `storage.completeTaskWithOutboxIntent`: pembuatan intent outbox penyelesaian dan transisi status terminal task (`succeeded`, `delivery_uncertain`, atau `cancelled`) disatukan ke dalam satu transaksi atomik SQLite write (`db.transaction("write")`). Tidak ada task terminal tanpa intent outbox, dan tidak ada intent outbox tanpa transisi terminal task.
  3. Memeriksa status intent outbox secara jujur: jika intent sudah `delivered`, task diselesaikan sebagai `succeeded`; jika `uncertain`, task dialihkan ke `delivery_uncertain` tanpa blind resend; jika `cancelled`, task diselesaikan sebagai `cancelled`.
  4. `TaskRunner.runTask` terbukti idempoten saat dipanggil ulang pada task yang langkah-langkahnya sudah selesai.

### B. Penguatan Test Integrasi Nyata
- **Test 17 Diperkuat (B.1)**: Mensimulasikan restart recovery dengan me-reset status task yang telah sukses ke `retry_wait`, menjalankan worker kedua, lalu meng-assert bahwa status akhir tetap `succeeded` (bukan `failed`) dan jumlah record outbox untuk key `final_task_completion_outbox` tepat 1.
- **Test 39 Baru (B.2)**: Mensimulasikan crash antara pembuatan intent dan `completeTask` di mana intent outbox telah dikirim transport. Setelah di-resume oleh worker kedua, task berhasil `succeeded`, outbox tidak terduplikasi, dan transport terbukti TIDAK mengirim dua kali (`mockTransport.sent.length === 1`).
- **Test 22 Diperkuat (B.3)**: Menjalankan task nyata multi-langkah (`summarize_context` -> `create_note`) pada mode shadow dengan file uji terisolasi. Membuktikan SHA-256 file produksi tidak berubah sama sekali, nol pemanggilan transport nyata, dan delivery receipt outbox tersimulasi dengan flag `simulated: true` dan `shadow: true`.

### C. Keputusan Desain: "Satu Langkah Tiap Checkpoint"
- **Pilihan yang Ditetapkan**: Pilihan (ii) — sengaja dipertahankan eksekusi multi-langkah di dalam loop pemanggilan runner untuk menjaga latensi tetap responsif (tanpa delay tick interval 2 detik antar langkah), **dengan penegakan ketat checkpoint persisten setelah setiap langkah**.
- **Bukti Persistensi (Test 40)**:
  - Setiap langkah meng-assert lease dan fencing token.
  - Hasil langkah disimpan ke tabel `task_steps` dengan status `succeeded` dan idempotency record.
  - State task disimpan via `leaseManager.checkpointTask`: versi task naik secara monotonik (tercatat `>= 3` pada task 2 langkah), lease diperbarui, dan snapshot anggaran diperbarui.
  - Ketika worker kedua me-resume task, langkah yang telah `succeeded` tidak pernah dieksekusi ulang (counter eksekusi handler tetap 1).
  - Tidak ada status `running` yang menggantung tanpa lease/recovery (dijamin oleh `LeaseManager` dan `runStartupRecovery`).

### D. Penurunan Scope dan Kontrol Izin Actor (Over-Permission Guard)
- **Masalah Sebelum Koreksi**: `TaskRunner` menetapkan `execContext.activeScopes` secara hardcoded berisi `["group", "dm", "active_chat", "read", "write"]` untuk seluruh actor tanpa seleksi hak.
- **Perbaikan yang Diterapkan**:
  - Dibuat method `TaskRunner.deriveActiveScopes(task, actor)`.
  - Channel diturunkan spesifik (`group` bila `@g.us`, `dm` bila chat pribadi).
  - Scope dasar: `active_chat` dan `read`.
  - Scope `write` HANYA diberikan jika:
    1. Actor adalah owner terverifikasi (`canaryManager.isOwner(task.actor_pn) === true`), ATAU
    2. `task.authorization_ref` memuat izin tulis yang sah (`authorized`, `admin`, `owner`, `veto`, `write`), ATAU
    3. `task.scope` secara eksplisit memuat token `write`/`read_write` dan bukan `read_only`.
  - Penolakan ketat identitas raw WhatsApp LID (`DENIED_RAW_LID`), penolakan actor unverified (`DENIED_UNVERIFIED_ACTOR`), dan penolakan provenance palsu (`DENIED_INVALID_PROVENANCE`).
  - **Bukti (Test 41)**: Actor biasa tanpa hak tulis gagal saat mencoba `create_note` dengan error `Izin tidak lengkap: kekurangan scope [write]`, sedangkan actor berhak berhasil tuntas.

### E. Penggunaan `final_response` dan Sanitasi Observability
- Jika rencana GLM Flash memiliki field `final_response`, teks tersebut digunakan sebagai isi pesan outbox penyelesaian task.
- Jika tidak ada `final_response`, digunakan teks default yang jujur: `"Tugas berhasil diselesaikan dengan bukti lengkap."`.
- Destinasi pengiriman outbox selalu ditentukan oleh runtime (`latestTask.chat_id`), model dilarang menginjeksi destinasi.
- Seluruh event audit melewati `redactObject`: tidak ada API key (`sk-or-v1-`), Bearer token, data URL base64, atau Chain-of-Thought yang tersimpan ke SQLite.
- Penanganan error internal menyensor pesan error (maksimal 500 karakter) dan tidak memasukkan raw cause atau call stack mentah ke audit details.

---

## 4. Daftar Status Kapabilitas (Active vs Inactive)

### A. Kapabilitas Aktif (MVP Deterministic Subset)
| Nama Capability | Risk Level | Side Effect | Idempotency | Scopes Wajib | Keterangan |
|---|---|---|---|---|---|
| `create_note` | Low | Write (DB Notes) | `read_write` | `active_chat`, `write` | Menyimpan catatan terisolasi per `chat_id`. Validasi input: title & content. |
| `read_note` | Low | None (DB Read) | `read_only` | `active_chat`, `read` | Membaca catatan milik `chat_id` yang sama (menolak cross-chat access). |
| `summarize_context` | Low | None (Deterministic) | `read_only` | `active_chat`, `read` | Meringkas konteks pesan/topik obrolan tanpa side effect eksternal. |
| `export_archive` | High | Send (Outbox Intent) | `at_least_once` | `active_chat`, `write` | Operasi sensitif: wajib persetujuan (`requiresApproval=true`), fail-closed bila belum disetujui. |

### B. Kapabilitas Nonaktif / Dilarang Keras di Fase 3
| Kategori Kapabilitas | Status | Alasan Keamanan / Guard |
|---|---|---|
| Direct WhatsApp Send (`sock.sendMessage`) | **NONAKTIF** | Dilarang keras. Semua pesan keluar wajib melalui `outbox` Fase 2. |
| Filesystem Write / Shell Execution / Bash | **NONAKTIF** | Mencegah arbitrary code execution (RCE) dan integritas host. |
| Arbitrary Web Fetch / URL Scraping | **NONAKTIF** | Mencegah SSRF (Server-Side Request Forgery) dan kebocoran credential. |
| Broad Messaging / Mass Forwarding | **NONAKTIF** | Kebijakan anti-spam dan anti-broadcast terbukti di Fase 1. |
| Database Arbitrary SQL Write | **NONAKTIF** | Model hanya berinteraksi melalui fungsi terabstraksi di SQLiteStorage. |

---

## 5. Rincian 42 Skenario Pengujian Integrasi DeterministiK

Seluruh pengujian berada di [test/autonomous-task-loop.test.js](file:///D:/EXPERIMENT/A/test/autonomous-task-loop.test.js):

1. **Happy Multi-Step Task**: Eksekusi rencana 3 langkah (`summarize_context` -> `create_note` -> `read_note`) hingga tuntas dengan status `succeeded` dan bukti verifikasi lengkap.
2. **Bad Planner JSON**: Respons planner bukan JSON valid ditolak secara fail-closed (`bad_planner_json`).
3. **Bad Planner Schema**: Output model melanggar skema Ajv strict ditolak secara fail-closed (`planner_schema_violation`).
4. **Plan Step Bounds Exceeded**: Rencana melebihi batas 8 langkah ditolak langsung (`plan_too_many_steps`).
5. **Model Injection - Injected Destination**: Upaya model menginjeksi chat target di luar origin chat dibatalkan fail-closed (`injection_attempt`).
6. **Model Injection - Injected IdempotencyKey**: Upaya model menginjeksi idempotency key manual dibatalkan (`injection_attempt`).
7. **Model Injection - Injected Policy/Approval**: Upaya model menyelipkan metadata persetujuan palsu dibatalkan (`injection_attempt`).
8. **Capability Deny - Unregistered**: Permintaan kapabilitas yang tidak terdaftar di registry menggagalkan task (`capability_not_found`).
9. **Capability Deny - Disabled**: Permintaan kapabilitas yang dinonaktifkan menggagalkan task (`capability_disabled`).
10. **Approval Needed**: Kapabilitas berisiko tinggi menghentikan eksekusi ke status `waiting_approval`.
11. **Approval Granted & Single-Use**: Persetujuan hanya dapat dikonsumsi satu kali; konsumsi kedua ditolak fail-closed.
12. **Approval Argument Hash Mismatch**: Perubahan argumen membatalkan persetujuan yang sudah ada (`approval_args_mismatch`).
13. **Timeout / Abort in Capability**: Kapabilitas yang menggantung melebihi timeout dibatalkan via `AbortController`.
14. **Retry Budget Exhausted**: Kegagalan berulang menghabiskan jatah retry (maksimal 2), task dialihkan ke `failed` (`retry_budget_exhausted`).
15. **Duplicate Inbox Event**: Event duplikat dengan `sourceEventId` yang sama tidak menghasilkan task ganda.
16. **Raw WhatsApp LID Rejection**: Event dengan format raw LID ditolak secara fail-closed sebelum DB (`inbox_raw_lid_rejected`).
17. **Restart Resume Outbox Idempotency (Point A & B.1)**: Reset task sukses ke retry_wait lalu dijalankan worker lain; status tetap `succeeded` dan outbox completion tepat 1 record.
18. **Fencing Takeover**: Worker usang dengan fencing token lama ditolak ketika worker baru mengambil alih lease (`StaleFencingTokenError`).
19. **Cancellation Before Outbox**: Kenaikan `context_epoch` membatalkan antrean outbox sebelum pesan dikirim ke transport.
20. **Cancellation During Multi-Step**: Kenaikan `context_epoch` di tengah multi-step task segera membatalkan langkah berikutnya.
21. **Shadow Mode Zero External Effect**: Eksekusi di shadow mode hanya menghasilkan outbox tersimulasi, transport WhatsApp tidak pernah dipanggil.
22. **Shadow Mode Zero Production Write (Point B.3)**: Task nyata multi-langkah di shadow mode menjaga SHA-256 file produksi identik, nol send transport, dan outbox tersimulasi.
23. **Agent Mode Canary Fail-Closed**: Mode agent dengan allowlist kosong menolak semua efek samping keluar (`canary_denied`).
24. **Agent Mode Canary Success**: Nomor PN dan grup yang terdaftar pada allowlist diizinkan mengirim ke outbox.
25. **Cross-Chat Note Isolation**: Upaya `read_note` membaca data milik obrolan lain ditolak secara deterministik.
26. **Audit Secret Redaction**: Kunci API, Bearer token, data URL base64 disensor menjadi `[REDACTED]` pada log audit.
27. **Verifier Output Mismatch**: Output observasi kapabilitas yang tidak memenuhi skema keluaran ditolak oleh `TaskVerifier`.
28. **Acceptance Criteria Verification**: `TaskVerifier` memeriksa kriteria penerimaan langkah sebelum task dinyatakan `succeeded`.
29. **Invariant - No Hanging Running State**: Crash recovery membersihkan task `running` yang ditinggalkan worker mati menjadi `retry_wait`.
30. **ProcessLock Lifecycle Integration**: Task loop hanya dapat dimulai jika `ProcessLock` berhasil diperoleh.
31. **Inbound Dispatcher - Legacy Mode Preservation**: Legacy mode mempertahankan 100% legacy handler tanpa membuat event atau task di runtime SQLite.
32. **Inbound Dispatcher - Agent Addressed Command**: Perintah `/task catat` yang dialamatkan ke bot di mode agent menghasilkan durable event & task lalu dieksekusi runner hingga `succeeded`.
33. **Inbound Dispatcher - Duplicate Baileys Event**: Pesan duplikat dengan Baileys message ID (`m.key.id`) yang sama di-dedup secara atomik di SQLite; hanya menghasilkan tepat 1 task.
34. **Inbound Dispatcher - Casual Group Chat Ignored**: Pesan obrolan grup biasa tanpa tag/mention bot diabaikan oleh router dan tidak membuat task di SQLite.
35. **Inbound Dispatcher - Raw WhatsApp LID Fail-Closed**: Identitas raw WhatsApp LID ditolak fail-closed sebelum DB dan tidak membuat task.
36. **Inbound Dispatcher - Persisted Context Epoch & /clear /reset**: Perintah `/clear` & `/reset` menaikkan chat context epoch secara transaksional di SQLite; setelah DB restart, task & outbox lama yang belum delivered terbukti dibatalkan dan epoch tetap bertahan.
37. **Inbound Dispatcher - Shadow Inbound Safety**: Inbound `/task` di mode shadow menghasilkan eksekusi simulasi dengan nol pesan keluar ke transport WhatsApp dan hash file produksi tidak berubah sama sekali.
38. **Inbound Dispatcher - ProcessLock Failure Fail-Closed**: Ketika ProcessLock tidak dipegang oleh lifecycle, dispatcher langsung no-op fail-closed (`lock_not_held`) tanpa membuat task baru.
39. **Point B.2 Integration**: Crash simulasi antara pembuatan intent dan completeTask; setelah resume status `succeeded`, outbox tidak terduplikasi, dan transport tidak mengirim dua kali.
40. **Point C Checkpoint Persistence**: Checkpoint per langkah tersimpan persisten di SQLite, version task naik, dan resume tidak mengulang langkah yang telah `succeeded`.
41. **Point D Scope Derivation**: Penolakan write pada actor tanpa hak, verified true, PN valid, dan penolakan raw LID.
42. **Point E final_response & Audit**: GLM final_response digunakan pada outbox completion payload dengan destinasi chat asal yang sah, serta log audit bebas rahasia dan error internal bersih dari raw cause.

### Addendum review independen (23 September 2026)

Laporan awal di atas mencatat 3 langkah sukses, tetapi belum menguji replan yang diwajibkan gate Fase 3. Implementasi langsung menambahkan replan terbatas saat `read_note` gagal karena ID tidak ditemukan, sebelum ada efek tulis/kirim. Penggantian langkah, penandaan langkah lama `superseded`, `plan_version`, dan bukti disimpan dalam satu transaksi SQLite dengan fencing. Test baru membuktikan plan pengganti menjalankan tiga langkah, memilih final response terbaru, dan menolak replan untuk akses note lintas chat. Simulasi OpenRouter nyata melalui `node scripts/simulate-replan.js` juga lulus: GLM menghasilkan plan pengganti valid, dua langkah dikonfirmasi, dan outbox tidak dikirim. Database serta file memori/job simulasi berada di temp. Replan umum untuk jenis kegagalan lain belum didukung; gate Fase 3 perlu dinilai dengan batas kemampuan ini, bukan diklaim sebagai replan universal. Suite penuh saat addendum: 197/197 lulus.

---

## 6. Bukti Validasi Foreground & Rilis Gate

1. **Syntax Check (`node --check`)**:
   - `node --check index.js` -> Bersih.
   - `node --check ai/runtime/lifecycle.js` -> Bersih.
   - `node --check ai/runtime/inbox.js` -> Bersih.
   - `node --check ai/runtime/task-runner.js` -> Bersih.
   - `node --check ai/runtime/intent-router.js` -> Bersih.
   - `node --check ai/runtime/storage/sqlite-storage.js` -> Bersih.
   - `node --check ai/runtime/storage/migrations.js` -> Bersih.
   - `node --check ai/runtime/storage/db.js` -> Bersih.
   - `node --check ai/runtime/cancellation.js` -> Bersih.
   - `node --check ai/runtime/outbox.js` -> Bersih.
   - `node --check test/autonomous-task-loop.test.js` -> Bersih.
2. **Pengujian Suite Penuh (`npm test`) 3 Kali Berturut-turut**:
   - **Run 1**: 187 passed, 0 failed, 0 cancelled, 0 skipped, durasi ~6.3s (100% PASS).
   - **Run 2**: 187 passed, 0 failed, 0 cancelled, 0 skipped, durasi ~6.3s (100% PASS).
   - **Run 3**: 187 passed, 0 failed, 0 cancelled, 0 skipped, durasi ~6.3s (100% PASS).
   *(Mencakup 8 berkas test: `bot.test.js`, `ai.test.js`, `agent.test.js`, `foundation.test.js`, `runtime-storage.test.js`, `runtime-recovery.test.js`, `runtime-lifecycle.test.js`, `autonomous-task-loop.test.js`)*.
3. **Audit Dependensi (`npm audit --omit=dev`)**:
   - Hasil: `found 0 vulnerabilities`.
4. **Git Diff Check (`git diff --check`)**:
   - Hasil: Kode bersih, nol error format whitespace, nol conflict markers.
5. **Simulasi Ekosistem Bot dengan File Temp Terisolasi (OpenRouter Real API, Foreground)**:
   - `npm run simulate:ai`: 13/13 skenario klasifikasi Jev & GLM lulus.
   - `npm run simulate:burst`: 4 pesan masuk beruntun digabung jadi 1 balasan, 3 superseded, 1 reply terkirim.
   - `npm run simulate:memory`: GLM memory compact berhasil dan mencetak ringkasan memori dengan timestamp WIT.
   - `npm run simulate:dm`: 5/5 skenario chat pribadi (jawaban santai, opini, reminder, penolakan broadcast, dan opt-out) lulus, gerbang proaktif aman.
6. **Integritas File Dilindungi (SHA-256 Identik Sebelum & Sesudah Seluruh Pengujian)**:
   - `.env`: `BDB5B66C31FC5995BD75A907FF4CBF7EA9FD925C704843E79A58B3480C9EE368` (Identik)
   - `ai-memory.json`: `76EAAECB50ED38EB927AEC1B8AD30E1F9A2B1E06EEDBDDB81CAC33AE423F955C` (Identik)
   - `agent-jobs.json`: `B0D4C3B2E08DC120E6B058450B22CA19411C85C40929E64464348693F4E96050` (Identik)
   - `data.json`: `5CA01C99940B9AED2BD9890A79CCC05150251EB00561D550ADE184DFC2C072F8` (Identik)
