# Orchestrator Langsung — Overhaul AI Agent

Dokumen ini adalah mandat kerja untuk agent yang mengambil alih orkestrasi overhaul di `D:\EXPERIMENT\A`.

## Tujuan

Selesaikan seluruh fase dalam [`Plan.md`](../../Plan.md) dengan mengedit dan memverifikasi source secara langsung. Instruksi pengguna terbaru melarang Antigravity (`agy`).

## Batas keras

- Jangan edit, hapus, baca isi, atau log `auth/`.
- Jangan edit `.env`, `ai-memory.json`, `agent-jobs.json`, atau `data.json`.
- Jangan commit, push, deploy, restart bot produksi, atau mengirim pesan WhatsApp nyata.
- Jangan cetak API key, kredensial, token, data URL media, atau isi rahasia ke output.
- Default tetap `RUNTIME_ENGINE_MODE=legacy`. Shadow dan agent hanya untuk test terisolasi hingga gate rollout disetujui.
- Untuk simulasi, selalu gunakan `AI_MEMORY_FILE` dan `AGENT_JOBS_FILE` unik di `test/`, lalu hapus hanya file sementara tersebut setelah proses selesai.

## Siklus kerja per fase

1. Baca [`Plan.md`](../../Plan.md), [`AGENTS.md`](../../AGENTS.md), laporan fase terakhir, `git status --short`, dan diff terkait.
2. Periksa status source dan test lokal. Proses Antigravity Fase 4 telah dihentikan; jangan jalankan ulang.
3. Audit secara independen:
   - Cari bypass policy, raw LID, direct `sock.sendMessage`, write JSON produksi, fallback fail-open, state yang hilang saat crash, dan test yang hanya menguji helper.
   - Pastikan feature flag default legacy tidak mengubah perilaku bot eksisting.
   - Untuk storage/outbox: pastikan claim/lease/fencing, idempotency, crash pre-send vs post-send, context epoch, dan recovery benar-benar diuji.
   - Untuk shadow: buktikan nol send/presence serta hash memory/jobs produksi tidak berubah pada storage yang benar-benar digunakan.
4. Jalankan validasi mandiri sebelum menerima fase:
   ```powershell
   node --check index.js
   node --check ai/group-agent.js
   node --check ai/direct-agent.js
   node --check ai/scheduler.js
   npm test
   npm audit --omit=dev
   git diff --check
   ```
   Untuk perubahan runtime baru, lakukan `node --check` juga pada setiap file runtime yang berubah. Jalankan `npm test` minimal tiga kali bila fase menambah concurrency, persistence, scheduler, atau lifecycle.
5. Jalankan simulasi OpenRouter nyata secara satu-per-satu, foreground, dengan file state unik:
   ```powershell
   $env:AI_MEMORY_FILE='test\orchestrator-ai-memory.json'; $env:AGENT_JOBS_FILE='test\orchestrator-ai-jobs.json'; npm run simulate:ai
   $env:AI_MEMORY_FILE='test\orchestrator-burst-memory.json'; $env:AGENT_JOBS_FILE='test\orchestrator-burst-jobs.json'; npm run simulate:burst
   $env:AI_MEMORY_FILE='test\orchestrator-memory-memory.json'; $env:AGENT_JOBS_FILE='test\orchestrator-memory-jobs.json'; npm run simulate:memory
   $env:AI_MEMORY_FILE='test\orchestrator-dm-memory.json'; $env:AGENT_JOBS_FILE='test\orchestrator-dm-jobs.json'; npm run simulate:dm
   ```
   Hash `ai-memory.json`, `agent-jobs.json`, dan `data.json` sebelum dan sesudah. Hapus hanya file temporary test yang dibuat oleh langkah ini.
6. Bila ada celah, perbaiki source secara langsung, tambahkan test yang membuktikan perilaku dari jalur runtime, lalu jalankan gate yang relevan.
7. Hanya setelah seluruh audit dan gate lulus, tulis/perbarui laporan `PHASE<N>_..._REPORT.md`, lalu mulai fase berikutnya.

## Kontrak fase

| Fase | Deliverable utama | Gate minimal |
|---|---|---|
| 0 | Baseline audit | Inventory, API probe, hash produksi, tidak ada perubahan kode |
| 1 | Provider/policy/capability/budget/trace | Strict schema, authorization, cancellation, idempotency, redaction |
| 2 | Runtime durable | SQLite, lease/fencing, outbox, recovery, shadow isolation, process lock |
| 3 | Autonomous task loop MVP | Planner bounded, task checkpoint, verifier, capability registry, canary allowlist fail-closed |
| 4 | Media dan web tool | Video frame fail-soft, asset store privat, SSRF/domain/schema/rate-limit guard |
| 5 | Memory provenance dan proaktif | Scope/TTL/consent/provenance, no cross-chat leak, suppression/human takeover |
| 6 | Python sandbox opsional | Disabled default, isolated resources, no secret/network, audit artifact |
| 7 | Rollout | Shadow soak, canary allowlist, metrics, rollback rehearsal, izin pengguna sebelum produksi |

## Kriteria selesai

Overhaul hanya selesai setelah semua fase Plan.md selesai, test dan simulasi lulus mandiri, laporan menyatakan batas yang jujur, dan rollout Fase 7 telah memperoleh izin eksplisit pengguna untuk langkah yang irreversible. Hapus automation/heartbeat pemantau hanya pada titik itu.
