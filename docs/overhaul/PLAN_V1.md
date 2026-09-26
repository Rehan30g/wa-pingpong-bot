# Plan Overhaul: Agen Otonom Jev + GLM Flash

Tanggal: 22 September 2026
Status: rancangan implementasi; belum diterapkan pada bot/VPS.
Target: bot WhatsApp di `/home/ubuntu/GITKARA2.1`, checkout lokal `D:\EXPERIMENT\A`.

## 1. Hasil yang dituju

AI menerima tujuan pengguna, memahami konteks, menentukan langkah, menggunakan tools, mengamati hasil, memperbaiki kegagalan, dan menyelesaikan tugas dengan bukti. Tugas tetap tersimpan saat proses restart. Percakapan sehari-hari tetap singkat dan natural.

Jev menjadi lapisan keputusan cepat. GLM Flash menjadi perencana, pemilih tool beserta argumen, penafsir hasil, dan penulis balasan. Kode runtime memegang otorisasi, eksekusi, penyimpanan, batas biaya, dan keputusan apakah bukti teknis memenuhi syarat selesai.

Otonomi berarti bebas memilih langkah di dalam tujuan dan izin yang diberikan. AI tidak menciptakan tujuan tanpa mandat, memperluas penerima pesan, atau menaikkan izinnya sendiri.

### Contoh hasil akhir

- “Ambil gambar yang tadi, buat stiker, lalu kirim di sini.” Agen memilih `entry_id`, mengambil asset, mengonversi, memverifikasi WebP, lalu mengirim ke chat yang sama.
- “Cari informasi terbaru tentang X, bandingkan sumbernya, simpan ringkasannya.” Agen mencari, membaca sumber, menyusun ringkasan bertautan, menyimpan note, dan memastikan note dapat dibaca kembali.
- “Ingatkan besok jam 8 WIT.” Agen membuat job persisten dengan waktu eksplisit, membalas tanggal/jam yang dipahami, dan mengirim ketika jatuh tempo.
- “Lanjutkan tugas tadi.” Agen memuat checkpoint dan melanjutkan langkah yang belum selesai tanpa mengulang pengiriman yang sudah berhasil.
- Permintaan ambigu diklarifikasi seperlunya; langkah aman yang sudah jelas tetap dapat disiapkan.

## 2. Makna standar agen AI dalam plan ini

Tidak ada satu sertifikasi universal yang otomatis membuat sistem memenuhi seluruh “standar AI Agent sekarang”. Dokumen ini menetapkan baseline engineering yang dapat diuji, dengan referensi primer pada bagian 16.

Prinsip loop mandiri, observasi hasil tool, dan kondisi berhenti mengikuti pola agen yang dijelaskan [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). Evaluasi dipisahkan menjadi kualitas hasil dan jejak eksekusi, mengacu pada [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Kontrol keamanan dipetakan terhadap risiko dalam [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/).

| Syarat | Implementasi yang wajib ada | Bukti kelulusan |
|---|---|---|
| Berorientasi tujuan | Task menyimpan tujuan, batas scope, acceptance criteria | Selesai hanya setelah kriteria terverifikasi |
| Perencanaan adaptif | GLM memilih langkah berdasarkan observasi terbaru | Mampu mengubah rencana saat tool gagal |
| Tool use nyata | Registry, schema, executor, hasil terstruktur | Ada artefak/hasil eksternal yang dapat dicek |
| State dan memori | Checkpoint persisten; memori dengan sumber dan scope | Restart tidak menghilangkan tugas |
| Pemulihan | Retry terbatas, rekonsiliasi, idempotensi | Fault injection tidak menggandakan efek samping |
| Pengawasan manusia | Status, cancel, persetujuan spesifik bila diperlukan | Pencabutan izin berlaku sebelum efek berikutnya |
| Keamanan | Policy di luar model; isolasi data dan executor | Semua kasus kritis ditolak |
| Observability | Trace per task, latency, token, biaya, error | Dapat menelusuri penyebab gagal tanpa membuka rahasia |
| Evaluasi | Dataset regresi dan simulasi API nyata | Target bagian 13 tercapai |
| Interoperabilitas | Kontrak tool berversi; adapter opsional | Tool baru tidak memerlukan perubahan loop utama |

MCP, vector database, dan banyak subagent bukan prasyarat kelulusan. Versi pertama menggunakan satu runtime agen dengan dua peran model agar biaya dan debugging terkontrol.

## 3. Kondisi awal dan gap yang ditemukan

Didasarkan pada pembacaan source lokal, bukan audit live VPS:

| Bagian sekarang | Dipertahankan | Perombakan |
|---|---|---|
| `index.js` | Baileys, identitas, command game/admin, akses grup | Jadikan adapter event dan delivery |
| `ai/group-agent.js` | Debounce, Jev, multimodal, quote, receipt | Pisahkan konteks, routing, runtime, dan delivery |
| `ai/direct-agent.js` | Whitelist PN, anti-broadcast, gaya DM | Gunakan runtime bersama dengan policy DM |
| `ai/memory-store.js` | Profil, grup, hubungan, migrasi v2 | Tambahkan provenance, ACL, retrieval, invalidasi |
| `ai/scheduler.js` | Reminder, follow-up, check-in | Durable claim/lease, retry, checkpoint dan rekonsiliasi |
| `ai/capabilities/registry.js` | Registry eksplisit, default nonaktif | Schema wajib, executor, policy, audit, verifier |
| `Plan.md` sebelumnya | Fetch/kirim media, stiker, storage, Python | Seluruh capability dimasukkan ke roadmap ini |

Gap konkret: riwayat/antrean utama masih berada dalam Map proses; registry belum menjadi loop eksekusi; scheduler mengeluarkan job jatuh tempo dari penyimpanan sebelum eksekusi sehingga ada celah kehilangan job saat crash. `runDueJobs` juga berhenti seluruhnya ketika agent dinonaktifkan, padahal kontrak AGENTS.md meminta reminder eksplisit tetap berjalan saat proaktif mati. Perbedaan ini harus diperbaiki dan diuji pada migrasi.

## 4. Pembagian tanggung jawab model

### Jev: keputusan diskret

- Gunakan model konfigurasi saat ini `typesafe/jev-1.13`; adapter endpoint saat ini `/api/alpha/decisions`.
- Pilih `ignore`, `react`, `reply`, `start_task`, `continue_task`, atau `clarify` dari opsi yang valid untuk event.
- Saat diperlukan, pilih `continue`, `replan`, atau `stop` berdasarkan ringkasan langkah. Jangan wajib memanggil Jev pada setiap tool bila tidak menambah kualitas.
- Input berupa teks, sinyal media, task summary, dan daftar pilihan yang telah dibatasi policy. Jangan menganggap Jev dapat melihat gambar/video.
- Confidence membantu routing dan dikalibrasi pada dataset lokal; confidence tidak pernah menjadi izin eksekusi.
- Kegagalan Jev: retry terbatas. Pesan yang jelas ditujukan ke bot boleh diteruskan ke GLM untuk balasan/clarification tanpa write tool; percakapan grup biasa tidak memicu tindakan spekulatif.

### GLM Flash: rencana dan pelaksanaan melalui tools

- Gunakan konfigurasi saat ini `z-ai/glm-5.3-flash`, reasoning `low` sebagai baseline.
- Ubah permintaan menjadi tujuan, kriteria selesai, serta langkah ringkas; tugas sederhana langsung menjawab tanpa membuat rencana panjang.
- Pilih tool, susun argumen, baca observasi, revisi rencana, dan susun hasil berdasarkan bukti.
- Gunakan native tool calling jika didukung provider. Jika tidak, gunakan action envelope JSON tervalidasi; JSON gagal parse tidak pernah dieksekusi.
- Ringkas memori dengan sumber dan scope; jangan mencatat inferensi sebagai fakta terverifikasi.
- Balasan WhatsApp tetap natural; detail panjang menjadi artefak atau ditampilkan bila diminta.

### Gate kompatibilitas sebelum implementasi besar

Identitas model di atas berasal dari kode lokal. Dukungan tool calling, strict JSON schema, modality, batas konteks, reasoning, harga, dan provider aktif harus diuji lewat adapter dan API nyata. Dokumentasi OpenRouter menjelaskan mekanismenya, tetapi dukungan aktual bergantung model/provider ([tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)). Jangan mengklaim dukungan GLM berdasarkan nama model saja.

Simpan hasil probe tersanitasi dan versi adapter. Pin model/provider yang lolos; perubahan provider memicu pengujian ulang. Jika fitur penting tidak tersedia, nonaktifkan capability terkait dan laporkan batasnya. Jangan mengganti model ke keluarga lain diam-diam.

## 5. Arsitektur target

```text
WhatsApp / job jatuh tempo / perintah kontrol
  -> Normalisasi event + identitas PN + deduplikasi
  -> Policy awal + konteks sesuai scope
  -> Jev: routing
       -> ignore / react / balasan sederhana
       -> Task runtime
            -> GLM: rencana atau next action
            -> Validasi schema + policy + budget + context epoch
            -> Executor tool
            -> Simpan hasil/checkpoint
            -> Verifier: bukti vs kriteria selesai
            -> lanjut / replan / menunggu / selesai / gagal
  -> Outbox -> delivery WhatsApp -> rekonsiliasi status
```

Usulan modul baru, dibuat bertahap:

```text
ai/providers/{jev,glm,openrouter-client}.js
ai/runtime/{orchestrator,task-store,event-queue,budget}.js
ai/policy/{authorize,scopes,approvals}.js
ai/tools/{registry,executor,schemas}.js
ai/memory/{retrieve,provenance,compaction}.js
ai/delivery/{outbox,reconcile}.js
ai/observability/{trace,metrics,redact}.js
ai/evals/fixtures/
```

`group-agent.js`, `direct-agent.js`, dan `scheduler.js` menjadi adapter kompatibilitas saat migrasi. `capabilities/registry.js` didelegasikan ke registry baru; jangan memelihara dua registry independen.

## 6. Kontrak runtime dan lifecycle task

Task wajib menyimpan `task_id`, `chat_id`, `requester_pn`, `source_event_id`, `goal`, `acceptance_criteria`, `scope`, `authorization_ref`, `context_epoch`, `plan_version`, `steps`, `status`, `budget`, `evidence_refs`, serta timestamp UTC. Tampilan pengguna memakai WIT.

State utama: `queued -> running -> verifying -> succeeded`. Cabang: `waiting_input`, `waiting_approval`, `retry_wait`, `delivery_uncertain`, `failed`, `cancelled`, `budget_exhausted`. Resume kembali ke `queued` setelah input/izin/jadwal valid. Status terminal tidak dibuka kembali tanpa task/resume yang eksplisit dan tercatat.

Setiap iterasi:

1. Muat checkpoint dan event baru; cek cancel, epoch, izin, serta budget.
2. Bentuk konteks dari tujuan, ringkasan, bukti terbaru, dan tool yang diizinkan.
3. GLM menghasilkan salah satu `tool_call`, `ask_user`, `final`, atau `stop` dalam schema berversi.
4. Runtime memvalidasi nama tool, argumen, scope, izin, dan precondition. Identitas serta tujuan pengiriman berasal dari runtime, bukan argumen bebas model.
5. Persist intent sebelum efek samping; jalankan tool dengan timeout/cancellation.
6. Persist observasi dan biaya; verifier memeriksa hasil. Lanjut hanya bila ada kemajuan atau recovery yang sah.
7. `final` merupakan usulan selesai. Runtime menolak klaim sukses jika bukti kurang, delivery belum pasti, atau acceptance criteria belum terpenuhi.

Observasi tool berisi `tool_call_id`, `ok`, `data`, `artifact_ids`, `evidence`, `error_code`, `retryable`, `side_effect_status`, dan `duration_ms`. Catat ringkasan keputusan yang dapat diaudit, bukan chain-of-thought internal.

### Antrean dan interupsi

- Satu writer aktif per chat; mulai dengan maksimum dua task aktif global dan antrean terbatas yang memberikan status saat penuh.
- Deduplikasi berdasarkan ID pesan Baileys + chat + participant. Debounce dan perilaku superseded tetap berlaku.
- Pesan baru tidak membatalkan evaluasi biasa yang sedang berjalan. Integrasikan koreksi tujuan pada checkpoint dan periksa ulang sebelum write berikutnya.
- `cancel`, pencabutan izin, `/clear`, dan `/reset` membatalkan efek yang belum dikirim melalui epoch. Efek yang sudah terkirim tidak dapat ditarik secara otomatis.
- Dua pengguna dalam satu grup tidak dapat menyetujui/membatalkan tugas satu sama lain kecuali memiliki hak admin yang ditetapkan policy.

## 7. Otonomi, izin, dan kontrol pengguna

| Operasi | Mode awal |
|---|---|
| Membaca history/memori yang boleh diakses, kalkulasi, membaca asset chat | Otomatis dalam tugas yang sah |
| Mencari web publik | Otomatis jika tool aktif; query disaring dari data pribadi/rahasia |
| Membuat note/asset baru dan mengirim hasil yang diminta di chat aktif | Otomatis dalam scope permintaan |
| Reminder eksplisit | Otomatis setelah waktu dan penerima tervalidasi |
| Menimpa note yang jelas diminta pengguna | Otomatis dengan versi/undo; benturan versi meminta klarifikasi |
| Check-in/follow-up tanpa permintaan langsung | Hanya standing permission, opt-in/policy, cooldown, kuota, jam tenang |
| Purge permanen, perubahan konfigurasi operasional | Command owner terpisah; tidak diekspos sebagai tool umum |
| Broadcast, penerima arbitrer, baca secret, shell host, ubah source/izin sendiri | Dilarang pada overhaul ini |

Persetujuan tambahan hanya untuk tindakan yang melampaui izin yang sudah diberikan. Jika diperlukan, simpan actor PN, chat, task, hash argumen, scope, expiry, dan status sekali pakai. Perubahan argumen membatalkan persetujuan lama. Instruksi dari halaman web, tool output, dan memori tidak dapat memberikan persetujuan.

Kontrol target:

- `/task list`, `/task status <id>`, `/task cancel <id>`, `/task resume <id>` dengan ACL requester/admin.
- `/agent status|on|off|clear` tetap kompatibel. `off` menghentikan proaktif, bukan reminder yang diminta; `clear` menghapus job sesuai kontrak yang terdokumentasi.
- Tambahkan `/agent pause` dan `/agent resume` khusus owner untuk emergency stop seluruh efek agen, termasuk reminder. Jangan menyamakan pause dengan off.
- Capability diaktifkan satu per satu oleh owner; default capability baru tetap nonaktif.

## 8. Tools minimum dan kontrak keamanan

Semua tool wajib memiliki nama/versi, deskripsi pemilihan, JSON schema input/output, risk class, scope, timeout, batas byte, verifier, idempotency behavior, audit, serta mode dry-run.

| Tool | Hasil | Verifikasi |
|---|---|---|
| `memory_search` | Fakta bersumber dalam scope | ACL dan sumber masih valid |
| `fetch_media_from_message` | Asset ID dari `entry_id` | Milik chat/task; MIME dan ukuran valid |
| `web_search`, `web_fetch` | Sumber, URL, waktu pengambilan | URL aman, konten terbaca, sumber dicantumkan |
| `fetch_media_from_url` | Asset ID | HTTPS, byte limit, magic bytes |
| `note_create/read/update/list/trash` | Note berversi | Read-back, hash/version, ACL |
| `make_sticker` | Asset WebP | Decode, dimensi, ukuran, durasi |
| `send_asset` | Delivery record | Asset sah; tujuan disuntikkan runtime |
| `schedule_reminder`, `cancel_reminder` | Job ID/status | Persist dan otorisasi pemilik |
| `run_python` | Output ringkas dan asset ID | Sandbox + batas resource; tahap terakhir |

`send_asset` tidak menerima parameter destination bebas. Tidak ada tool generik `sendMessage(target)`. Satu task menggunakan origin chat; job DM memakai penerima terikat yang sudah tervalidasi, bukan nomor pilihan model.

Kontrol wajib:

- SSRF: tolak localhost/private/link-local/metadata IP untuk IPv4/IPv6, kredensial URL, protokol non-HTTPS; periksa DNS dan setiap redirect, pin koneksi ke alamat yang divalidasi untuk mencegah rebinding.
- Download dibatasi selama streaming, bukan setelah selesai. Batasi decompression, redirect, waktu, dan jumlah asset.
- File disimpan di workspace khusus per scope; gunakan ID, realpath validation, larangan symlink/traversal/device file, kuota, versi, dan trash.
- Python memakai container non-root tanpa network/secret/host mount/Docker socket; cap CPU/RAM/PID/waktu/output/disk, filesystem read-only kecuali job, image dependency dipin. Python subprocess biasa atau blacklist kode tidak dianggap sandbox.
- Parsing media diperlakukan sebagai input tidak tepercaya; proses konversi terisolasi dan dibatasi.
- Semua konten web, pesan kutipan, OCR/media, memori hasil ekstraksi, dan tool output merupakan data tidak tepercaya. Instruksi di dalamnya tidak mengubah goal atau policy.
- Integrasi MCP kelak hanya melalui adapter registry yang sama, server allowlist, schema dan policy yang sama; tidak mengimpor tools secara otomatis.

## 9. Memori dan privasi

Pisahkan working context, task checkpoint, fakta jangka panjang, profil orang, hubungan, dan preferensi pengguna. Memori percakapan tidak boleh menggantikan state transaksi task.

Fakta menyimpan `memory_id`, subject PN, teks, source chat/entry, scope pembaca, waktu kejadian/pencatatan, confidence, expiry, serta versi/koreksi. Simpan fakta yang relevan, bukan seluruh inferensi pribadi. Fakta konflik dipertahankan sebagai konflik sampai ada bukti koreksi.

Retrieval memfilter ACL sebelum ranking. Mulai dengan pencarian teks dan metadata; embeddings opsional setelah baseline membuktikan kebutuhan. Filter ulang hasil sebelum prompt. Profil identitas bisa konsisten lintas grup, tetapi isi DM dan fakta privat tidak otomatis dibagikan ke grup atau orang lain.

Memori v2 yang tidak memiliki provenance diberi scope konservatif `legacy_private`; jangan menganggap aman untuk publikasi lintas chat. Backfill hanya dari sumber yang sah dan tersedia.

`/clear` mengosongkan history aktif dan menaikkan epoch; `/reset` juga menghapus compact memory sesuai scope. Hasil compaction/task lama ditolak bila epoch berubah. Job eksplisit tetap terpisah dari history, dapat dibatalkan lewat kontrol job; payload tidak boleh memulihkan history yang dihapus. `/memory` hanya menampilkan informasi yang actor berhak lihat.

Default retensi usulan: asset sementara 24 jam, trace tersanitasi 14 hari, detail task selesai 30 hari; preferensi/izin bertahan sampai dicabut. Hapus asset turunan dan indeks saat sumber dihapus sesuai scope, dengan tombstone untuk menolak write lama. Runtime DB, asset, trace, `.env`, auth, dan payload pribadi tidak masuk Git.

## 10. Persistence, recovery, dan scheduler

Gunakan SQLite transaksional untuk task, step, event inbox, job, approval, outbox, dan ledger biaya. Pilih driver kompatibel Node target melalui probe instalasi VPS; jangan mengandalkan built-in SQLite Node versi yang belum diverifikasi. Abstraksi storage menjaga opsi mengganti backend tanpa mengubah tools.

- Claim job memakai lease + owner worker + fencing/version agar worker lama tidak dapat menulis setelah lease diambil ulang.
- Satu proses bot aktif dengan process lock; task resume menunggu koneksi WhatsApp siap.
- Intent dan outbox dibuat dalam transaksi, lalu delivery dilakukan di luar transaksi. Simpan hasil dan status setelahnya.
- Retry hanya error sementara, dengan backoff+jitter dan maksimum percobaan. Error policy/schema bukan retry tanpa perubahan.
- Idempotency key stabil untuk operasi logis, bukan dibuat baru setiap retry. Argumen berubah berarti operasi baru dengan pemeriksaan izin ulang.
- Untuk pengiriman WhatsApp, jangan menjanjikan exactly-once bila transport tidak menjaminnya. Simpan message ID bila tersedia dan rekonsiliasi. Crash sesudah send sebelum commit masuk `delivery_uncertain`; jangan blind resend. Bila status tidak bisa dibuktikan, tampilkan ketidakpastian dan minta tindakan pengguna bila diperlukan.
- Reminder yang terlewat saat downtime memakai grace period usulan 24 jam, dikirim sekali dengan penanda terlambat; yang lebih lama menjadi expired. Reminder berulang belum masuk MVP.
- Check-in basi dilewati, bukan ditumpuk. Opt-out tetap menghentikan DM; reminder yang sudah diminta tetap tunduk whitelist dan opt-out sesuai kontrak saat ini.
- Restart tidak mengosongkan job. Backup konsisten dan restore wajib diuji dengan database, asset references, serta versi schema.

## 11. Budget dan observability

Angka berikut merupakan default awal yang harus dikalibrasi, bukan klaim performa model:

| Batas | Usulan awal |
|---|---|
| Langkah tool per task | 8 |
| Replan | 2 |
| Retry error sementara per operasi | 2 tambahan; tetap dihitung ke budget |
| Timeout model / tool biasa | 30 detik / 20 detik |
| Wall time aktif task | 180 detik; waktu waiting tidak dihitung |
| Total panggilan model per task | 12, termasuk Jev, GLM, repair, verification |
| Langkah identik tanpa kemajuan | 2 lalu berhenti/replan |
| Pengingat status | Maksimal satu saat tugas lama, kemudian perubahan bermakna |

Biaya USD per task/hari menjadi konfigurasi owner sebelum mode write aktif, setelah harga aktual diverifikasi. Reserve perkiraan worst-case sebelum panggilan; reconcile usage setelahnya. Jika harga/usage tidak tersedia, terapkan batas token/panggilan konservatif dan jangan menganggap biaya nol. Budget habis menyimpan checkpoint dan status jelas, tidak meminta budget tambahan berulang otomatis.

Trace mencatat task/event/step/tool IDs, model/provider dan versi prompt, policy decision, token/biaya, latency, error tersanitasi, bukti, dan delivery state. Jangan mencatat API key, raw auth, base64 media, atau request/response lengkap secara default. Status pengguna menunjukkan kemajuan, bukan detail internal model.

Pantau success rate, unsupported rate, false completion, duplicate send, rejection policy, task macet, antrean, reminder laten, biaya per task, dan latency p50/p95. Circuit breaker provider mencegah banjir retry; tidak pernah fallback OpenRouter direct jika proxy VPS gagal.

## 12. Kompatibilitas yang wajib dipertahankan

- Command game/admin, allowedGroups, owner/veto, dan izin admin tetap bekerja.
- PN terverifikasi menjadi identitas; raw LID tidak pernah menjadi whitelist atau penerima.
- Orang asing di DM tidak memperoleh respons. Permintaan broadcast tetap ditolak dengan template tetap.
- Quote memakai `reply_to_entry_id`; null menghasilkan bubble standalone.
- Jenis sticker/attachment serta image/video/GIF/WebP dan konteks media terdahulu tetap tersedia sesuai batas.
- Debounce tidak membatalkan evaluasi berjalan; superseded yang belum dievaluasi tidak ditandai sudah dibaca oleh aplikasi.
- Read receipt dikirim setelah keputusan Jev, termasuk ignore; presence tersedia dan heartbeat tetap dijaga. Jumlah centang yang terlihat tetap bergantung layanan/perangkat WhatsApp, bukan jaminan runtime.
- Percakapan lanjutan dengan bot dan ack singkat tidak hilang karena threshold rendah.
- Auto-compact tetap diam, dan tidak menghidupkan kembali konteks setelah clear/reset.
- Rahasia `.env` dan `auth/` tidak diedit/dihapus; `data.json` tidak diedit manual saat bot aktif.
- OpenRouter VPS wajib melalui Privoxy/WARP. WhatsApp/GitHub tidak diarahkan ke proxy tersebut.

## 13. Evaluasi dan release gate

Buat dataset sintetis atau tersanitasi, gunakan mock clock/socket/executor, dan jalankan simulasi API nyata melalui proxy. Evaluasi memeriksa hasil/artefak dan jejak tindakan; penilaian GLM sendiri tidak cukup sebagai bukti sukses.

Minimum 60 skenario: 10 chat/routing, 15 multi-step tools, 10 memori/privasi, 10 crash/retry/delivery, 10 serangan/izin, 5 scheduler/budget. Ulangi skenario model-dependent tiga kali. Catat model/provider, versi prompt, tanggal, fixture, denominator, latency, serta biaya tiap run. Angka kelulusan berlaku pada suite ini, bukan jaminan terhadap seluruh serangan di dunia nyata.

| Gate | Target rilis awal |
|---|---|
| Critical safety | 100% kasus whitelist, lintas-chat, secret, broadcast, approval palsu, SSRF, sandbox ditolak |
| Efek samping ganda | 0 pada seluruh fault-injection suite |
| Klaim selesai palsu | 0; bukti wajib untuk success |
| Tugas yang didukung | >=90% sukses agregat; laporkan juga konsistensi 3/3 |
| Routing | >=95% pada dataset; laporkan false ignore pesan langsung terpisah |
| Restart/cancel/epoch | Seluruh kasus deterministik lulus |
| Reminder | <=60 detik dari due saat sistem sehat, tanpa duplikat |
| Balasan sederhana | Target p95 <=15 detik di kondisi sehat; pisahkan delay natural dan latency provider |
| Anggaran | Tidak ada pemanggilan baru setelah batas runtime tercapai |
| Naturalness | >=90% sampel diterima reviewer manusia menurut rubrik singkat/relevan/tidak repetitif |

Skenario wajib: media quoted dan lama; PN/LID ambigu; nama sama nomor berbeda; memori DM mencoba bocor ke grup; prompt injection dalam web/stiker/note; clear/reset saat compaction; pesan cepat saat task berjalan; izin dicabut sebelum send; crash sebelum/sesudah efek; proxy mati; JSON rusak; provider unsupported; opt-out; off versus pause; reminder saat restart; budget habis.

Validasi implementasi:

```bash
node --check index.js
node --check ai/group-agent.js
node --check ai/direct-agent.js
node --check ai/scheduler.js
npm test
npm run simulate:ai
npm run simulate:burst
npm run simulate:memory
npm run simulate:dm
git diff --check
```

Tambahkan test runtime baru ke script `npm test` secara eksplisit karena script saat ini hanya menyebut tiga file. Tambahkan simulator task/recovery sebagai script baru; jangan mengklaim sudah tersedia. Tes alur pesan harus memanggil `processGroupMessage` dan `processDirectMessage` langsung dengan mock socket. Simulasi memakai penerima/transport tes, tidak mengirim ke pengguna produksi.

## 14. Urutan implementasi dan kriteria selesai

| Fase | Pekerjaan | Gate sebelum lanjut |
|---|---|---|
| 0. Baseline | Inventaris source, baseline test, model/provider probe, kontrak izin dan biaya | Baseline terdokumentasi; batas API terbukti |
| 1. Fondasi | Adapter model, schema validator, policy, budget, trace redaction, registry tunggal | Policy negatif lulus; invalid JSON tidak dieksekusi |
| 2. Runtime durable | Task loop, SQLite, queue, checkpoint, lease, outbox, cancellation | Crash/restart/cancel dan delivery-uncertain lulus |
| 3. Agen MVP | Note, memory scoped, kalkulasi terkontrol, reminder; routing Jev + GLM | Tugas 3+ langkah selesai berdasarkan bukti, termasuk satu skenario replan |
| 4. Media dan web | Asset store, fetch, stiker, send asset, pencarian bersumber | SSRF/ACL/media limits lulus; artefak terkirim dan tervalidasi |
| 5. Memori dan proaktif | Provenance, migrasi v2, retrieval, expiry, standing permission | Tidak ada bocor lintas scope; off/opt-out/jam tenang lulus |
| 6. Sandbox opsional | Python/container dan output artefak | Semua tes isolasi/resource lulus; tetap nonaktif jika infrastruktur belum memadai |
| 7. Rilis bertahap | Shadow, canary, fault injection, evaluasi, rollback drill | Seluruh release gate dan observasi canary lulus |

Deliverable tiap fase: source, test langsung, fixture/simulasi relevan, laporan gate dengan bukti, migrasi/rollback bila ada, pembaruan README/AGENTS.md dan `.env.example` tanpa rahasia. Jangan menyalakan fase berikutnya hanya karena kode berhasil build.

MVP agen otonom tercapai pada fase 3. Overhaul produksi utama selesai setelah fase 4, 5, dan 7. Python merupakan capability tambahan, bukan syarat untuk menyebut runtime sebagai agen.

## 15. Migrasi, deployment, dan rollback

1. Tambahkan feature flag engine `legacy|shadow|agent` dan allowlist canary. Legacy tetap tersedia selama transisi.
2. Siapkan backup konsisten memory/jobs dan metadata versi schema; jangan membaca/menyalin isi auth ke log. Uji migrasi menggunakan fixture, bukan data produksi terlebih dahulu.
3. Cutover storage memakai maintenance singkat: hentikan claim job baru, drain task dan delivery, snapshot, import dalam transaksi, validasi jumlah/ID/checksum logis. Tidak ada dua writer aktif ke JSON dan SQLite.
4. JSON lama dipertahankan sebagai backup read-only. Task/jobs baru memakai DB; facade memory lama dapat dipertahankan sampai migrasi memori selesai dengan pemilik write yang tunggal.
5. Shadow minimal 24 jam: nilai proposal tanpa mengirim, menulis memori produksi, membuat job, atau menggandakan receipt/presence. Gunakan storage terpisah dan batasi biaya.
6. Canary satu grup dan DM tester yang sah minimal 48 jam, dengan sekurangnya 30 tugas beragam, tanpa insiden kritis. Waktu saja tidak cukup bila sampel belum terpenuhi.
7. Restart bot lewat `tmux send-keys -t wabot C-c`; verifikasi log, satu instance Node, koneksi WhatsApp, DB recovery, dan kesehatan proxy. Jangan menggunakan `/reboot` WhatsApp.
8. Perluas bertahap setelah gate. Rilis capability satu per satu; hentikan rollout jika ada kebocoran, duplicate send, false success, atau lonjakan biaya.

Rollback: pause claim dan write, drain/rekonsiliasi outbox, simpan snapshot DB terbaru, ubah engine ke legacy, lalu restart sesuai prosedur. Gunakan adapter ekspor untuk memory/jobs yang kompatibel beserta ledger deduplikasi; jangan memulihkan JSON lama secara buta karena reminder baru bisa hilang atau terkirim ulang. Task baru yang tidak dipahami legacy dibekukan, dilaporkan, dan tidak dipaksa dikonversi. Uji prosedur ini sebelum canary.

## 16. Referensi primer

Diakses 22 September 2026. Referensi digunakan sebagai prinsip desain; angka budget, pilihan SQLite, scope WhatsApp, dan gate di dokumen ini merupakan keputusan proyek.

- [Anthropic — Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): perbedaan workflow dan agent, loop berbasis observasi, stopping condition. Artikel fondasional; bukan katalog teknologi terbaru.
- [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): evaluasi hasil, trajectory, dan variasi antar percobaan.
- [OWASP — Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/): acuan threat model agen.
- [OpenRouter — Tool calling](https://openrouter.ai/docs/guides/features/tool-calling): protokol pemanggilan tool dan pengembalian hasil.
- [OpenRouter — Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs): schema output dan ketergantungan dukungan provider.
- [OpenRouter — Jev 1.13](https://openrouter.ai/typesafe/jev-1.13/api): peran Jev sebagai model keputusan terstruktur berbasis teks.

## 17. Definition of done

- [ ] Jev dan GLM Flash menjalankan pembagian peran melalui adapter teruji.
- [ ] Agen menyelesaikan tugas multi-step dengan tools nyata, replan, dan bukti hasil.
- [ ] Task/job selamat dari restart, cancel dan pencabutan izin efektif, serta ketidakpastian delivery ditangani jujur.
- [ ] Memori bersumber dan sesuai scope; clear/reset tidak memulihkan konteks lama.
- [ ] Seluruh invariants WhatsApp/DM dan fitur lama tetap lulus regresi.
- [ ] Anggaran, trace tersanitasi, status, emergency pause, dan kontrol owner bekerja.
- [ ] Seluruh gate kritis dan target kualitas lulus dengan laporan hasil nyata.
- [ ] Migrasi, restore, rollback, shadow, dan canary berhasil diverifikasi.
- [ ] Dokumentasi membedakan capability aktif, nonaktif, dan yang belum didukung.
