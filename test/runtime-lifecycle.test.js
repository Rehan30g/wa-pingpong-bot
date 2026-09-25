const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert");

const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-lifecycle-");

test.after(() => {
  cleanup();
});

const engineConfig = require("../ai/runtime/engine-config");
const { RuntimeLifecycle, initGlobalLifecycle, getGlobalLifecycle } = require("../ai/runtime/lifecycle");
const { createStorage } = require("../ai/runtime/storage");
const { runStartupRecovery } = require("../ai/runtime/recovery");
const { OutboxManager, OUTBOX_STATUS } = require("../ai/runtime/outbox");
const { CancellationManager } = require("../ai/runtime/cancellation");
const scheduler = require("../ai/scheduler");
const memoryStore = require("../ai/memory-store");

function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeMockSock() {
  const sent = [];
  const presences = [];
  return {
    sent,
    presences,
    sendMessage: async (jid, content) => {
      const msg = { jid, content, key: { id: `WA_MSG_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` } };
      sent.push(msg);
      return msg;
    },
    sendPresenceUpdate: async (type, jid) => {
      presences.push({ type, jid });
    },
  };
}

test("1. Default legacy masih memakai JSON dan tidak menyentuh DB runtime", async () => {
  const oldMode = process.env.RUNTIME_ENGINE_MODE;
  process.env.RUNTIME_ENGINE_MODE = "legacy";

  const tempJobsFile = path.join(testDir, "test-legacy-lifecycle-jobs.json");
  const oldJobsEnv = process.env.AGENT_JOBS_FILE;
  process.env.AGENT_JOBS_FILE = tempJobsFile;

  try {
    const lifecycle = new RuntimeLifecycle({ engineMode: "legacy" });
    const initResult = await lifecycle.init();
    assert.equal(initResult.mode, "legacy");
    assert.equal(initResult.lockHeld, false, "Legacy dilarang mengambil ProcessLock");
    assert.equal(lifecycle.storage, null, "Legacy dilarang menginisialisasi storage DB");

    // Jadwalkan job lewat adapter scheduler
    const job = scheduler.scheduleJob({
      type: "reminder",
      fire_at: Date.now() + 5000,
      payload: { phone: "628111111111", text: "Legacy test reminder" },
    });
    assert.ok(job.id, "Legacy scheduler mengembalikan job dengan id");

    // Status scheduler berbentuk synchronous object
    const status = scheduler.status();
    assert.equal(typeof status, "object");
    assert.ok(status.jobs >= 1, "Job tercatat di legacy store");

    // Verifikasi bahwa file JSON digunakan
    assert.ok(fs.existsSync(tempJobsFile), "File JSON jobs terbentuk");
    const jsonContent = JSON.parse(fs.readFileSync(tempJobsFile, "utf8"));
    assert.ok(jsonContent.jobs.some((j) => j.id === job.id));

    // Tidak ada file SQLite yang terbentuk dari legacy
    const dbPath = path.join(testDir, "runtime.db");
    assert.equal(fs.existsSync(dbPath), false, "DB runtime tidak boleh disentuh oleh legacy");
  } finally {
    if (oldMode === undefined) delete process.env.RUNTIME_ENGINE_MODE;
    else process.env.RUNTIME_ENGINE_MODE = oldMode;
    if (oldJobsEnv === undefined) delete process.env.AGENT_JOBS_FILE;
    else process.env.AGENT_JOBS_FILE = oldJobsEnv;
    try { fs.unlinkSync(tempJobsFile); } catch {}
  }
});

test("release drill lokal: agent berhenti, legacy tidak mengubah snapshot, restore DB menjaga job dan fakta", async () => {
  const dbPath = path.join(testDir, "release-drill.db");
  const backupPath = path.join(testDir, "release-drill-backup.db");
  const restoredPath = path.join(testDir, "release-drill-restored.db");
  const mockSock = makeMockSock();
  const chatId = "120363000000009@g.us";
  const agent = new RuntimeLifecycle({ engineMode: "agent", dbPath, sock: mockSock, workerId: "release_drill_agent" });
  try {
    await agent.init();
    assert.equal(agent.lockHeld, true);
    await agent.storage.recordMemoryFact({ chatId, subjectPn: "628123456789", sourceEntryId: "release-entry", text: "Rilis: uji lokal", contextEpoch: 0 });
    await agent.storage.createJob({ type: "reminder", fire_at: Date.now() + 86400000, payload: { phone: "628123456789", text: "uji lokal" }, status: "scheduled", max_attempts: 3 });
  } finally { await agent.shutdown(); }
  const checkpoint = await createStorage(dbPath);
  try { await checkpoint.db.execute("PRAGMA wal_checkpoint(TRUNCATE);"); }
  finally { await checkpoint.close(); }
  fs.copyFileSync(dbPath, backupPath);
  const before = fileSha256(dbPath);
  const legacy = new RuntimeLifecycle({ engineMode: "legacy", dbPath, sock: mockSock });
  try {
    await legacy.init();
    assert.equal(legacy.storage, null);
    assert.equal(legacy.lockHeld, false);
    assert.equal(fileSha256(dbPath), before);
    assert.equal(mockSock.sent.length, 0);
    assert.equal(mockSock.presences.length, 0);
  } finally { await legacy.shutdown(); }
  fs.copyFileSync(backupPath, restoredPath);
  const restored = await createStorage(restoredPath);
  try {
    assert.equal((await restored.storage.searchMemoryFacts({ chatId, actorPn: "628123456789", query: "Rilis" })).length, 1);
    const jobs = await restored.db.execute("SELECT COUNT(*) AS c FROM jobs WHERE status = 'scheduled';");
    assert.equal(Number(jobs.rows[0].c), 1);
    assert.equal(mockSock.sent.length, 0);
  } finally { await restored.close(); }
});

test("2. Shadow mode menghasilkan nol send dan tidak memodifikasi hash JSON produksi", async () => {
  const oldMode = process.env.RUNTIME_ENGINE_MODE;
  process.env.RUNTIME_ENGINE_MODE = "shadow";

  const prodMemoryPath = path.join(testDir, "prod-ai-memory.json");
  const prodJobsPath = path.join(testDir, "prod-agent-jobs.json");
  const shadowDbPath = path.join(testDir, "shadow-runtime.db");

  // Daftarkan nomor telepon di struktur memori produksi dummy sebelum pengujian
  const phone = "628123456789";
  const initialMemoryContent = {
    version: 2,
    groups: {
      "120363000000000@g.us": {
        glm: "Belum ada memori terkompresi.",
        jev: "Belum ada konteks keputusan terkompresi.",
        updated_at_wit: null,
        compact_log: [],
      },
    },
    people: {
      [phone]: {
        name: "Shadow User",
        aliases: [],
        groups: ["120363000000000@g.us"],
        profile: "",
        relation: "",
        first_seen_wit: "2026-09-22 10:00:00 WIT",
        last_seen_wit: "2026-09-22 10:00:00 WIT",
        dm: {
          glm: "Belum ada memori DM.",
          jev: "Belum ada konteks keputusan DM.",
          updated_at_wit: null,
          compact_log: [],
          opt_out: false,
          last_bot_dm_wit: null,
          last_proactive_at: null,
          proactive_day: null,
          proactive_count: 0,
        },
      },
    },
    relationships: {},
    settings: { enabled: true },
  };

  fs.writeFileSync(prodMemoryPath, JSON.stringify(initialMemoryContent, null, 2));
  fs.writeFileSync(prodJobsPath, JSON.stringify({ jobs: [] }, null, 2));

  const oldMemEnv = process.env.AI_MEMORY_FILE;
  const oldJobsEnv = process.env.AGENT_JOBS_FILE;
  process.env.AI_MEMORY_FILE = prodMemoryPath;
  process.env.AGENT_JOBS_FILE = prodJobsPath;

  // Reload memoryStore agar benar-benar memakai storage prodMemoryPath yang aktif
  memoryStore.reload(prodMemoryPath);
  assert.equal(memoryStore.getMemoryFile(), path.resolve(prodMemoryPath), "memoryStore harus mengarah ke file produksi");
  assert.equal(memoryStore.canDirectMessage(phone), true, "Penerima harus dapat menerima DM dari file produksi");

  const initialMemoryHash = fileSha256(prodMemoryPath);
  const initialJobsHash = fileSha256(prodJobsPath);

  // Pasang spy pada noteBotDm untuk membuktikan bahwa API penulisan memoryStore dilarang dipanggil
  let noteBotDmCalled = false;
  const originalNoteBotDm = memoryStore.noteBotDm;
  memoryStore.noteBotDm = (...args) => {
    noteBotDmCalled = true;
    return originalNoteBotDm.apply(memoryStore, args);
  };

  const mockSock = makeMockSock();

  try {
    const lifecycle = new RuntimeLifecycle({
      engineMode: "shadow",
      dbPath: shadowDbPath,
      sock: mockSock,
      memoryStore,
    });

    const initResult = await lifecycle.init();
    assert.equal(initResult.mode, "shadow");
    assert.equal(initResult.lockHeld, true, "Shadow instance memperoleh ProcessLock terisolasi");

    // Jadwalkan due reminder di shadow
    await lifecycle.durableScheduler.scheduleJob({
      type: "reminder",
      fire_at: Date.now() - 1000,
      payload: { phone, text: "Shadow due reminder" },
    });

    // Jalankan scheduler
    const results = await lifecycle.durableScheduler.runDueJobs({ sock: mockSock, at: Date.now() });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "sent");

    // VERIFIKASI WAJIB:
    // 1. Nol pengiriman WhatsApp nyata
    assert.equal(mockSock.sent.length, 0, "Shadow mode WAJIB menghasilkan 0 send ke WhatsApp");
    // 2. Nol presence composing/paused
    assert.equal(mockSock.presences.length, 0, "Shadow mode WAJIB tidak memanggil presence update");
    // 3. noteBotDm WAJIB TIDAK DIPANGGIL
    assert.equal(noteBotDmCalled, false, "Shadow mode WAJIB tidak memanggil memoryStore.noteBotDm");
    // 4. Hash file JSON produksi TIDAK BERUBAH
    assert.equal(fileSha256(prodMemoryPath), initialMemoryHash, "Hash memori produksi tidak boleh berubah");
    assert.equal(fileSha256(prodJobsPath), initialJobsHash, "Hash jobs produksi tidak boleh berubah");

    // 5. Percobaan memanggil API penulisan produksi (setEnabled / setAgentSettings) ditolak eksplisit
    assert.throws(
      () => lifecycle.durableScheduler.setEnabled(false),
      /Mode shadow dilarang/,
      "DurableScheduler.setEnabled wajib melempar error pada mode shadow",
    );
    assert.throws(
      () => scheduler.setEnabled(false),
      /Mode shadow dilarang/,
      "scheduler.setEnabled wajib melempar error pada mode shadow",
    );
    assert.throws(
      () => memoryStore.setAgentSettings({ enabled: false }),
      /Mode shadow dilarang/,
      "memoryStore.setAgentSettings wajib melempar error pada mode shadow",
    );
    assert.equal(fileSha256(prodMemoryPath), initialMemoryHash, "Hash memori produksi tetap tidak berubah setelah percobaan mutasi");

    // 6. DB shadow mencatat outcome semata di SQLite shadow (job sent & outbox delivered dengan simulated receipt)
    const shadowJobs = await lifecycle.storage.listJobs();
    assert.equal(shadowJobs.length, 1, "Job tercatat di database shadow");
    assert.equal(shadowJobs[0].status, "sent");

    const shadowOutbox = await lifecycle.storage.listOutbox();
    assert.equal(shadowOutbox.length, 1, "Outbox intent tercatat di database shadow");
    assert.equal(shadowOutbox[0].status, "delivered");
    assert.equal(shadowOutbox[0].delivery_receipt.simulated, true, "Delivery receipt adalah simulasi");

    await lifecycle.shutdown();
  } finally {
    memoryStore.noteBotDm = originalNoteBotDm;
    if (oldMode === undefined) delete process.env.RUNTIME_ENGINE_MODE;
    else process.env.RUNTIME_ENGINE_MODE = oldMode;
    if (oldMemEnv === undefined) delete process.env.AI_MEMORY_FILE;
    else process.env.AI_MEMORY_FILE = oldMemEnv;
    if (oldJobsEnv === undefined) delete process.env.AGENT_JOBS_FILE;
    else process.env.AGENT_JOBS_FILE = oldJobsEnv;
    memoryStore.reload();
    try { fs.unlinkSync(prodMemoryPath); } catch {}
    try { fs.unlinkSync(prodJobsPath); } catch {}
  }
});

test("3. Agent due reminder menghasilkan outbox intent lalu hanya OutboxManager transport mengirim satu kali", async () => {
  const oldMode = process.env.RUNTIME_ENGINE_MODE;
  process.env.RUNTIME_ENGINE_MODE = "agent";

  const dbPath = path.join(testDir, "agent-outbox-runtime.db");
  const mockSock = makeMockSock();
  const phone = "628999111222";

  memoryStore.recordParticipant({ phone, name: "Agent Target", groupId: "120363000000000@g.us", at: "2026-09-22 10:00:00 WIT" });

  try {
    const lifecycle = new RuntimeLifecycle({
      engineMode: "agent",
      dbPath,
      sock: mockSock,
    });

    await lifecycle.init();
    await lifecycle.onTransportReady({ sock: mockSock });

    // Jadwalkan due reminder
    const now = Date.now();
    const createdJob = await lifecycle.durableScheduler.scheduleJob({
      type: "reminder",
      fire_at: now - 500,
      payload: { phone, text: "Minum air putih ya" },
    });

    // Jalankan due jobs
    const execResults = await lifecycle.durableScheduler.runDueJobs({ sock: mockSock, at: now });
    assert.equal(execResults.length, 1);
    assert.equal(execResults[0].status, "sent");

    // Verifikasi 1: OutboxManager transport mengirim tepat satu kali
    assert.equal(mockSock.sent.length, 1, "Transport OutboxManager mengirim tepat 1 kali");
    assert.ok(mockSock.sent[0].content.text.includes("Minum air putih ya"));

    // Verifikasi 2: Di DB, outbox record berstatus 'delivered' dengan transport message ID
    const outboxItems = await lifecycle.storage.db.execute("SELECT * FROM outbox WHERE job_id = ?;", [createdJob.job_id]);
    assert.equal(outboxItems.rows.length, 1);
    const outboxRow = outboxItems.rows[0];
    assert.equal(outboxRow.status, "delivered");
    assert.ok(outboxRow.transport_message_id, "Transport message ID tersimpan");
    assert.ok(outboxRow.idempotency_key.startsWith("idemp_"), "Idempotency key deterministik tersimpan");

    // Verifikasi 3: Idempotency record tersimpan
    const idempRecord = await lifecycle.storage.getIdempotencyRecord(outboxRow.idempotency_key);
    assert.ok(idempRecord, "Idempotency record wajib tersimpan dalam transaksi atomik");

    // Verifikasi 4: Pemanggilan berikutnya tidak melakukan duplikasi pengiriman
    const repeatResults = await lifecycle.durableScheduler.runDueJobs({ sock: mockSock, at: now + 1000 });
    assert.equal(repeatResults.length, 0, "Tidak ada pengiriman berulang");
    assert.equal(mockSock.sent.length, 1, "Total send tetap 1");

    await lifecycle.shutdown();
  } finally {
    if (oldMode === undefined) delete process.env.RUNTIME_ENGINE_MODE;
    else process.env.RUNTIME_ENGINE_MODE = oldMode;
  }
});

test("4. Crash pre-send vs restart: claimed outbox pulih ke pending dengan fencing bump, bukan uncertain", async () => {
  const dbPath = path.join(testDir, "crash-presend.db");
  const conn = await createStorage(dbPath);
  const now = Date.now();
  const pastMs = now - 10000;

  try {
    memoryStore.recordParticipant({ phone: "628111111111", name: "Presend User", groupId: "120363000000000@g.us", at: "2026-09-22 10:00:00 WIT" });
    // Simulasi worker crash saat status 'claimed' sebelum memanggil transport
    await conn.storage.createOutboxIntent({
      outbox_id: "out_presend_crash_1",
      task_id: "task_presend_1",
      destination: "628111111111@s.whatsapp.net",
      payload: { text: "Pesan yang belum dipanggil transport" },
      idempotency_key: "idemp_presend_crash_1",
      status: "claimed",
    });
    // Set lease_until kedaluwarsa
    await conn.storage.db.execute({
      sql: "UPDATE outbox SET status = 'claimed', lease_until = ?, fencing_token = 1 WHERE outbox_id = 'out_presend_crash_1';",
      args: [pastMs],
    });

    // Jalankan startup recovery (proses restart)
    const recoveryResult = await runStartupRecovery(conn.storage, { nowMs: now });
    assert.equal(recoveryResult.recoveredClaimedOutbox, 1, "Outbox claimed yang kedaluwarsa dipulihkan");
    assert.equal(recoveryResult.reconciledOutbox, 0, "Outbox claimed TIDAK BOLEH menjadi uncertain");

    // Periksa status di DB
    const itemAfterRecovery = await conn.storage.getOutbox("out_presend_crash_1");
    assert.equal(itemAfterRecovery.status, "pending", "Status wajib kembali ke pending untuk re-claim aman");
    assert.equal(itemAfterRecovery.fencing_token, 2, "Fencing token wajib dinaikkan untuk menolak klaim basi");
    assert.equal(itemAfterRecovery.worker_id, null);
    assert.equal(itemAfterRecovery.lease_until, null);

    // Drain outbox sesudah restart: pesan berhasil dikirim tanpa kendala
    const outboxManager = new OutboxManager(conn.storage);
    const mockTransport = {
      send: async ({ destination, payload }) => ({ messageId: "WA_RECOVERED_SEND" }),
    };
    const drained = await outboxManager.drainOutbox(mockTransport);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].status, "delivered");
  } finally {
    await conn.close();
  }
});

test("5. Crash post-send vs restart: sending outbox menjadi uncertain dan DILARANG blind resend", async () => {
  const dbPath = path.join(testDir, "crash-postsend.db");
  const conn = await createStorage(dbPath);
  const now = Date.now();
  const pastMs = now - 10000;

  try {
    // Simulasi worker crash tepat sesudah transport mengirim (status 'sending')
    await conn.storage.createOutboxIntent({
      outbox_id: "out_postsend_crash_1",
      task_id: "task_postsend_1",
      destination: "628111111111@s.whatsapp.net",
      payload: { text: "Pesan yang crash post-send" },
      idempotency_key: "idemp_postsend_crash_1",
      status: "sending",
    });
    await conn.storage.db.execute({
      sql: "UPDATE outbox SET status = 'sending', lease_until = ? WHERE outbox_id = 'out_postsend_crash_1';",
      args: [pastMs],
    });

    // Jalankan startup recovery (proses restart)
    const recoveryResult = await runStartupRecovery(conn.storage, { nowMs: now });
    assert.equal(recoveryResult.reconciledOutbox, 1, "Outbox sending wajib direkonsiliasi");

    // Status wajib menjadi 'uncertain'
    const itemAfterRecovery = await conn.storage.getOutbox("out_postsend_crash_1");
    assert.equal(itemAfterRecovery.status, "uncertain", "Status wajib menjadi uncertain!");

    // Drain outbox: TIDAK BOLEH mengirim ulang pesan uncertain secara buta!
    let blindResendAttempted = false;
    const monitoringTransport = {
      send: async () => {
        blindResendAttempted = true;
        return { messageId: "BLIND_RESEND_ERROR" };
      },
    };
    const outboxManager = new OutboxManager(conn.storage);
    await outboxManager.drainOutbox(monitoringTransport);
    assert.equal(blindResendAttempted, false, "Pesan uncertain dilarang di-resend secara buta!");

    // Rekonsiliasi eksplisit dengan bukti delivery
    const reconciled = await outboxManager.reconcileDelivery({
      outboxId: "out_postsend_crash_1",
      transportMessageId: "WA_PROOF_CONFIRMED_999",
      confirmed: true,
    });
    assert.equal(reconciled.status, "delivered");
  } finally {
    await conn.close();
  }
});

test("6. Process lock dipakai lifecycle dan mencegah double-instance tanpa menjatuhkan legacy", async () => {
  const dbPath = path.join(testDir, "process-lock-lifecycle.db");

  // Instance 1 memulai lifecycle
  const instance1 = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    workerId: "instance-worker-1",
  });
  const res1 = await instance1.init();
  assert.equal(res1.lockHeld, true);

  // Instance 2 mencoba membuka DB yang sama
  const instance2 = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    workerId: "instance-worker-2",
  });
  const res2 = await instance2.init();
  // Lock failure mencegah loop durable start tanpa menjatuhkan aplikasi
  assert.equal(res2.lockHeld, false);
  assert.equal(res2.started, false);
  assert.ok(res2.error, "Error lock failure dilaporkan");

  // Instance 1 shutdown dan melepaskan lock
  await instance1.shutdown();

  // Instance 2 kini dapat memperoleh lock
  const retryRes2 = await instance2.init();
  assert.equal(retryRes2.lockHeld, true);

  await instance2.shutdown();
});

test("7. Cancellation / context epoch bump membatalkan outbox sebelum delivery", async () => {
  const dbPath = path.join(testDir, "cancellation-epoch.db");
  const conn = await createStorage(dbPath);
  const outboxManager = new OutboxManager(conn.storage);
  const cancellationManager = new CancellationManager(conn.storage);
  const destination = "628777777777@s.whatsapp.net";

  try {
    // 1. Buat intent pada context epoch 0
    const item = await outboxManager.createIntent({
      taskId: "task_epoch_cancel",
      destination,
      payload: { text: "Pesan yang akan dibatalkan" },
      contextEpoch: 0,
      logicalOperationId: "step_epoch_test",
    });

    // 2. Naikkan context epoch chat (mis. ada perintah /clear atau reset)
    cancellationManager.bumpEpoch(destination);
    assert.equal(cancellationManager.getEpoch(destination), 1);

    // 3. Coba kirim: guard wajib mendeteksi epoch kadaluwarsa sebelum memanggil transport
    let transportCalled = false;
    const mockTransport = {
      send: async () => {
        transportCalled = true;
        return { messageId: "SHOULD_NOT_HAPPEN" };
      },
    };

    const processed = await outboxManager.processOutboxItem(item, mockTransport, {
      cancellationManager,
    });

    assert.equal(transportCalled, false, "Transport dilarang dipanggil jika epoch kadaluwarsa");
    assert.equal(processed.status, "cancelled");
    assert.ok(processed.error_message.includes("Context epoch kadaluwarsa"));
  } finally {
    await conn.close();
  }
});

test("8. Duplikasi idempotency first-write-wins bertahan lintas restart dan mendeteksi konflik", async () => {
  const dbPath = path.join(testDir, "idempotency-restart.db");
  const key = "idemp_exact_restart_key_1";
  const taskId = "task_restart_1";
  const logicalOperationId = "op_send_msg_1";
  const firstResult = { messageId: "WA_ORIGINAL_MSG_1", text: "Halo pertama" };

  // Sesi 1: Simpan record pertama
  const conn1 = await createStorage(dbPath);
  try {
    const saved = await conn1.storage.saveIdempotencyRecord(key, {
      taskId,
      capabilityName: "send_message",
      logicalOperationId,
      resultRedacted: firstResult,
    });
    assert.equal(saved.idempotency_key, key);
  } finally {
    await conn1.close();
  }

  // Sesi 2: Buka ulang DB dari koneksi baru (restart)
  const conn2 = await createStorage(dbPath);
  try {
    // Cek record lama bertahan
    const existing = await conn2.storage.getIdempotencyRecord(key);
    assert.ok(existing);
    assert.equal(existing.result_redacted.messageId, "WA_ORIGINAL_MSG_1");

    // First-write-wins: insert ulang dengan payload identik mengembalikan record pertama
    const rewriteSame = await conn2.storage.saveIdempotencyRecord(key, {
      taskId,
      capabilityName: "send_message",
      logicalOperationId,
      resultRedacted: firstResult,
    });
    assert.equal(rewriteSame.result_redacted.messageId, "WA_ORIGINAL_MSG_1");

    // Konflik: percobaan menyimpan key yang sama dengan logical operation atau payload berbeda -> DITOLAK
    await assert.rejects(
      async () => {
        await conn2.storage.saveIdempotencyRecord(key, {
          taskId,
          capabilityName: "send_message",
          logicalOperationId: "op_different_conflicting",
          resultRedacted: { messageId: "WA_CONFLICT" },
        });
      },
      (err) => err.code === "IDEMPOTENCY_CONFLICT",
      "Perubahan logicalOperationId pada key yang sama wajib melempar IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await conn2.close();
  }
});

test("9. Bila ProcessLock gagal, adapter scheduler menolak semua schedule/tick/runDueJobs tanpa DB write/send; jalan normal setelah lock bebas", async () => {
  const oldMode = process.env.RUNTIME_ENGINE_MODE;
  process.env.RUNTIME_ENGINE_MODE = "agent";

  const dbPath = path.join(testDir, "lock-fail-adapter-test.db");
  const mockSock = makeMockSock();
  const phone = "628999888777";

  // 1. Instance 1 sukses memegang lock resmi pada database
  const instance1 = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    workerId: "instance-holder-1",
  });
  const res1 = await instance1.init();
  assert.equal(res1.lockHeld, true, "Instance 1 wajib memegang lock");

  // 2. Instance 2 mencoba initGlobalLifecycle pada database yang sama -> ProcessLock gagal
  const instance2 = await initGlobalLifecycle({
    engineMode: "agent",
    dbPath,
    workerId: "instance-holder-2",
    sock: mockSock,
  });
  assert.equal(instance2.lockHeld, false, "Instance 2 wajib gagal memperoleh lock");
  assert.equal(instance2.started, false, "Instance 2 durable loop dilarang start");
  assert.equal(instance2.storage, null, "Instance 2 dilarang membiarkan storage terbuka");
  assert.ok(instance2.initResult.error, "Hasil lock failure terekspos secara aman");

  // 3. Adapter scheduler WAJIB menolak semua scheduleJob, tick, dan runDueJobs dengan error eksplisit
  // dan DILARANG membuka DB sendiri (tidak ada fallback createStorage)
  await assert.rejects(
    async () => {
      await scheduler.scheduleJob({
        type: "reminder",
        fire_at: Date.now() - 1000,
        payload: { phone, text: "Pesanan reminder gagal lock" },
      });
    },
    (err) => err.message.includes("DURABLE_SCHEDULER_LOCK_FAILED"),
    "scheduleJob wajib ditolak dengan DURABLE_SCHEDULER_LOCK_FAILED",
  );

  await assert.rejects(
    async () => {
      await scheduler.tick({ sock: mockSock });
    },
    (err) => err.message.includes("DURABLE_SCHEDULER_LOCK_FAILED"),
    "tick wajib ditolak dengan DURABLE_SCHEDULER_LOCK_FAILED",
  );

  await assert.rejects(
    async () => {
      await scheduler.runDueJobs({ sock: mockSock });
    },
    (err) => err.message.includes("DURABLE_SCHEDULER_LOCK_FAILED"),
    "runDueJobs wajib ditolak dengan DURABLE_SCHEDULER_LOCK_FAILED",
  );

  // 4. Verifikasi bahwa tidak ada write ke database baru dan nol pesan/presence terkirim
  assert.equal(mockSock.sent.length, 0, "Nol pengiriman WhatsApp saat lock gagal");
  assert.equal(mockSock.presences.length, 0, "Nol presence update saat lock gagal");

  // 5. Instance 1 shutdown dan melepaskan lock
  await instance1.shutdown();

  // 6. Sekarang lifecycle global resmi diinisialisasi ulang sesudah lock bebas
  const instance3 = await initGlobalLifecycle({
    engineMode: "agent",
    dbPath,
    workerId: "instance-holder-3",
    sock: mockSock,
  });
  assert.equal(instance3.lockHeld, true, "Instance 3 berhasil memegang lock");
  await instance3.onTransportReady({ sock: mockSock });

  // Daftarkan penerima agar lolos guard DM
  memoryStore.recordParticipant({ phone, name: "Unlocked User", groupId: "120363000000000@g.us", at: "2026-09-22 10:00:00 WIT" });

  // Sekarang adapter scheduler berjalan normal
  const scheduled = await scheduler.scheduleJob({
    type: "reminder",
    fire_at: Date.now() - 500,
    payload: { phone, text: "Pesan sukses sesudah lock bebas" },
  });
  assert.ok(scheduled.job_id, "Job berhasil dijadwalkan lewat adapter");

  const dueRuns = await scheduler.runDueJobs({ sock: mockSock });
  assert.equal(dueRuns.length, 1);
  assert.equal(dueRuns[0].status, "sent");
  assert.equal(mockSock.sent.length, 1, "Pesan terkirim tepat 1 kali");

  // 7. Verifikasi shutdown membersihkan global lifecycle
  await instance3.shutdown();
  assert.equal(getGlobalLifecycle(), null, "Shutdown wajib membersihkan global lifecycle agar tidak ada instance tersisa");

  if (oldMode === undefined) delete process.env.RUNTIME_ENGINE_MODE;
  else process.env.RUNTIME_ENGINE_MODE = oldMode;
});
