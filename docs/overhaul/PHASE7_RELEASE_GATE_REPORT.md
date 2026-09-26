# Fase 7 — Evaluasi dan rilis bertahap (lokal berjalan)

Status: **gate lokal belum cukup untuk rilis**. Tidak ada deploy, restart bot, perubahan `auth/`, commit, push, atau pesan WhatsApp nyata.

## Bukti lokal

| Gate | Hasil |
|---|---|
| Suite lengkap | **222/222 lulus pada run terbaru** setelah demo headless ditambahkan. Sebelumnya 221/221 lulus pada tiga run dan `npm audit --omit=dev` menemukan 0 vulnerability. |
| Evaluasi 60 skenario | `npm run evaluate:release`: 60 skenario unik lulus dari 222 tes (10 routing, 15 multi-step, 10 memori, 10 crash/delivery, 10 izin/serangan, 5 scheduler/budget). Semua adalah mock/fault-injection lokal; bukan 60 tugas WhatsApp produksi. |
| Simulasi model nyata | `simulate:ai`, `simulate:burst`, `simulate:memory`, `simulate:dm` masing-masing exit 0 pada tiga run dengan storage sementara. Itu menguji jalur Jev/GLM; bukan naturalness review manusia. |
| Data produksi | SHA-256 `ai-memory.json`, `agent-jobs.json`, dan `data.json` identik sebelum/sesudah simulasi. |
| Restore dan fallback lokal | Uji agent → legacy → restore SQLite dengan job terjadwal dan fakta berhasil; nol send/presence pada mock socket. |

Temuan penting saat drill: salinan **hanya file `runtime.db` tanpa checkpoint WAL** kehilangan data terbaru. Backup konsisten harus dilakukan saat writer berhenti, checkpoint `PRAGMA wal_checkpoint(TRUNCATE)` sukses, baru salin file DB (atau gunakan mekanisme backup SQLite yang setara). Jangan menyalin file utama saat bot masih menulis. Uji restore fixture setelah prosedur itu membuktikan job dan fakta tetap ada.

## Gate yang belum boleh dilewati otomatis

- Shadow minimal 24 jam pada lingkungan bot yang sebenarnya, dengan DB/asset terpisah dan bukti nol send/presence/write JSON produksi. Waktu, error, biaya, dan proposal task harus dicatat.
- Canary satu grup dan DM tester yang sah minimal 48 jam serta sedikitnya 30 tugas beragam; pengguna menjalankan uji WhatsApp langsung. Ukur delivery, duplicate send, false success, routing, latency, biaya, dan opt-out.
- Naturalness minimal 90% sampel menurut reviewer manusia. Penilaian ini tidak bisa diganti oleh tes mock atau API.
- Backup/restore/rollback pada snapshot staging yang merepresentasikan data target, termasuk asset references, outbox `delivery_uncertain`, dan ledger deduplikasi. Cutover butuh satu writer, maintenance singkat, dan rencana kembali ke `legacy` tanpa blind resend.
- Izin eksplisit sebelum deploy, restart bot produksi, atau pengiriman WhatsApp nyata.

Karena gate ini belum dijalankan, `RUNTIME_ENGINE_MODE=legacy` tetap default dan `release_ready=false` pada evaluator. Hasil lokal bukan klaim bahwa overhaul sudah aktif di produksi.

Manifest 60 nama test dan hitungan kategori tersimpan di [`RELEASE_EVAL_LOCAL.json`](./RELEASE_EVAL_LOCAL.json). Skenario 30 tugas WA yang menjadi tanggung jawab pengguna sudah disiapkan di [`CANARY_USER_TEST_GUIDE.md`](./CANARY_USER_TEST_GUIDE.md), tanpa menganggapnya telah dijalankan.
