const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, runtimeDb, testDir } = setupIsolatedTestEnv("wa-test-runtime-recovery-");

const test = require("node:test");
const assert = require("node:assert");

test.after(() => {
  cleanup();
});

const { createStorage } = require("../ai/runtime/storage");
const { DurableScheduler } = require("../ai/runtime/durable-scheduler");
const { OutboxManager, OUTBOX_STATUS } = require("../ai/runtime/outbox");
const { DurableBudget } = require("../ai/runtime/durable-budget");
const { AuditManager } = require("../ai/runtime/audit");
const { ProcessLock, ProcessLockError } = require("../ai/runtime/process-lock");
const { runStartupRecovery } = require("../ai/runtime/recovery");
const engineConfig = require("../ai/runtime/engine-config");
const { importLegacyJobs } = require("../ai/runtime/storage/legacy-importer");
const memoryStore = require("../ai/memory-store");
const fs = require("node:fs");

async function getIsolatedStorage(testName) {
  const dbPath = path.join(testDir, `${testName}.db`);
  return createStorage(dbPath);
}

function makeMockSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => {
      const msg = { jid, content, key: { id: `WA_MSG_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` } };
      sent.push(msg);
      return msg;
    },
    sendPresenceUpdate: async () => {},
  };
}

test("13. Scheduler proaktif off vs emergency pause", async () => {
  const { storage, close } = await getIsolatedStorage("test13");
  const scheduler = new DurableScheduler(storage);
  const sock = makeMockSock();
  const phone = "628111111111";

  // Daftarkan nomor ke whitelist DM
  memoryStore.recordParticipant({ phone, name: "Budi", groupId: "120363000000000@g.us", at: "2026-09-22 10:00:00 WIT" });

  try {
    const now = Date.now();
    // Jadwalkan reminder eksplisit yang sudah due
    await scheduler.scheduleJob({
      type: "reminder",
      fire_at: now - 1000,
      payload: { phone, text: "Minum vitamin" },
    });

    // A. Saat proactive off (AI_AGENT_PROACTIVE=false): reminder tetap dieksekusi!
    const oldProactive = process.env.AI_AGENT_PROACTIVE;
    process.env.AI_AGENT_PROACTIVE = "false";
    try {
      const results = await scheduler.runDueJobs({ sock, at: now });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "sent");
      assert.equal(sock.sent.length, 1);
      assert.ok(sock.sent[0].content.text.includes("Minum vitamin"));
    } finally {
      if (oldProactive === undefined) delete process.env.AI_AGENT_PROACTIVE;
      else process.env.AI_AGENT_PROACTIVE = oldProactive;
    }

    // B. Saat EMERGENCY PAUSE aktif: SELURUH klaim dan efek samping berhenti, termasuk reminder!
    await scheduler.scheduleJob({
      type: "reminder",
      fire_at: now - 500,
      payload: { phone, text: "Reminder saat emergency pause" },
    });

    scheduler.setEmergencyPaused(true);
    assert.equal(scheduler.isEmergencyPaused(), true);

    const pausedResults = await scheduler.runDueJobs({ sock, at: now });
    assert.equal(pausedResults.length, 0, "Emergency pause wajib menghentikan seluruh pengiriman");
    assert.equal(sock.sent.length, 1, "Tidak ada pesan baru yang dikirim saat emergency pause");

    // Cabut emergency pause
    scheduler.setEmergencyPaused(false);
    const resumedResults = await scheduler.runDueJobs({ sock, at: now });
    assert.equal(resumedResults.length, 1, "Setelah pause dicabut, reminder kembali dapat diproses");
    assert.equal(resumedResults[0].status, "sent");
  } finally {
    close();
  }
});

test("14. Reminder terlambat vs check-in basi (late & expired rules)", async () => {
  const { storage, close } = await getIsolatedStorage("test14");
  const scheduler = new DurableScheduler(storage);
  const sock = makeMockSock();
  const phone = "628111111111";

  memoryStore.recordParticipant({ phone, name: "Budi", groupId: "120363000000000@g.us", at: "2026-09-22 10:00:00 WIT" });

  try {
    const now = Date.now();
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;

    // A. Reminder terlambat 2 jam (<= 24 jam): dikirim sekali dengan metadata 'late'
    const jobLate = await scheduler.scheduleJob({
      type: "reminder",
      fire_at: now - 2 * HOUR,
      payload: { phone, text: "Jemput adik" },
    });

    const resLate = await scheduler.runDueJobs({ sock, at: now });
    assert.equal(resLate.length, 1);
    assert.equal(resLate[0].status, "sent");
    assert.equal(resLate[0].is_late, true);
    assert.ok(sock.sent[sock.sent.length - 1].content.text.includes("[Pengingat Terlambat]"));

    // B. Reminder terlambat 26 jam (> 24 jam): expired, tidak dikirim
    const jobExpired = await scheduler.scheduleJob({
      type: "reminder",
      fire_at: now - 26 * HOUR,
      payload: { phone, text: "Event kemarin lusa" },
    });

    const resExpired = await scheduler.runDueJobs({ sock, at: now });
    assert.equal(resExpired.length, 1);
    assert.equal(resExpired[0].status, "expired");

    // C. Proactive check-in basi (> 1 jam): otomatis expired / dilewati
    const jobStaleCheckin = await scheduler.scheduleJob({
      type: "proactive_checkin",
      fire_at: now - 2 * HOUR,
      payload: { phone, reason: "Sapaan lama" },
    });

    const resCheckin = await scheduler.runDueJobs({ sock, at: now });
    assert.equal(resCheckin.length, 1);
    assert.equal(resCheckin[0].status, "expired");
  } finally {
    close();
  }
});

test("15. Outbox crash matrix dan delivery_uncertain: tidak ada blind resend", async () => {
  const { storage, close } = await getIsolatedStorage("test15");
  const outboxManager = new OutboxManager(storage);

  try {
    // 1. Crash sebelum send: outbox tersimpan status 'pending'
    const item1 = await outboxManager.createIntent({
      taskId: "task_test15_1",
      destination: "628111111111@s.whatsapp.net",
      payload: { text: "Pesan intent 1" },
      logicalOperationId: "msg_op_1",
    });
    assert.equal(item1.status, OUTBOX_STATUS.PENDING);

    // 2. Normal send: berhasil dan delivery receipt tersimpan
    const mockTransport = {
      send: async ({ destination, payload }) => ({
        messageId: "WA_SRV_98765",
        destination,
        deliveredAt: new Date().toISOString(),
      }),
    };
    const processed1 = await outboxManager.processOutboxItem(item1, mockTransport);
    assert.equal(processed1.status, OUTBOX_STATUS.DELIVERED);
    assert.equal(processed1.transport_message_id, "WA_SRV_98765");

    // 3. Crash SESUDAH send SEBELUM commit (post-send crash simulation):
    const itemCrash = await outboxManager.createIntent({
      taskId: "task_test15_crash",
      destination: "628111111111@s.whatsapp.net",
      payload: { text: "Pesan yang kena crash post-send" },
      logicalOperationId: "msg_op_crash",
    });

    const crashTransport = {
      simulateCrashPostSend: true,
      send: async () => ({ messageId: "WA_SENT_BEFORE_LOCAL_CRASH" }),
    };

    const processedCrash = await outboxManager.processOutboxItem(itemCrash, crashTransport);
    assert.equal(processedCrash.status, OUTBOX_STATUS.UNCERTAIN, "Wajib menjadi delivery_uncertain!");

    // 4. Drain outbox berikutnya TIDAK BOLEH mengirim ulang (no blind resend)
    let blindResendAttempted = false;
    const monitoringTransport = {
      send: async () => {
        blindResendAttempted = true;
        return { messageId: "BLIND_RESEND" };
      },
    };
    await outboxManager.drainOutbox(monitoringTransport);
    assert.equal(blindResendAttempted, false, "Pesan uncertain dilarang di-resend secara buta!");

    // 5. Rekonsiliasi dengan bukti ID transport
    const reconciled = await outboxManager.reconcileDelivery({
      outboxId: itemCrash.outbox_id,
      transportMessageId: "WA_SENT_BEFORE_LOCAL_CRASH",
      confirmed: true,
    });
    assert.equal(reconciled.status, OUTBOX_STATUS.DELIVERED);
  } finally {
    close();
  }
});

test("16. Budget survives restart: akumulasi penggunaan dan ledger tidak ter-reset", async () => {
  const dbPath = path.join(testDir, "test16.db");
  const taskId = "task_budget_persistence_1";

  // Sesi 1: Jalankan aktivitas model dan tool
  const conn1 = await createStorage(dbPath);
  try {
    await conn1.storage.createTask({
      task_id: taskId,
      goal: "Pengujian budget persistence",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "running",
    });

    const budget1 = new DurableBudget(taskId, conn1.storage);
    await budget1.init();

    // Catat reservasi & rekonsiliasi tool
    const resTool1 = await budget1.reserve({ type: "tool" });
    await budget1.reconcileToolAttempt(resTool1);

    // Catat panggilan model
    const resModel1 = await budget1.reserve({ type: "model" });
    await budget1.reconcile(resModel1, { actualTokens: 1200, actualCost: 0.0003 });

    // Catat retry
    await budget1.recordRetry();

    const snap1 = budget1.getSnapshot();
    assert.equal(snap1.usage.toolSteps, 1);
    assert.equal(snap1.usage.modelCalls, 1);
    assert.equal(snap1.usage.retries, 1);
    assert.equal(snap1.usage.tokensUsed, 1200);
    assert.equal(snap1.usage.costUsd, 0.0003);
  } finally {
    conn1.close();
  }

  // Sesi 2: Buka ulang database dari koneksi baru (simulasi restart proses bot)
  const conn2 = await createStorage(dbPath);
  try {
    const budget2 = new DurableBudget(taskId, conn2.storage);
    await budget2.init();

    const snap2 = budget2.getSnapshot();
    assert.equal(snap2.usage.toolSteps, 1, "toolSteps tidak boleh reset ke 0");
    assert.equal(snap2.usage.modelCalls, 1, "modelCalls tidak boleh reset ke 0");
    assert.equal(snap2.usage.retries, 1, "retries tidak boleh reset ke 0");
    assert.equal(snap2.usage.tokensUsed, 1200, "tokensUsed tidak boleh reset ke 0");
    assert.equal(snap2.usage.costUsd, 0.0003, "costUsd tidak boleh reset ke 0");

    // Lakukan aktivitas lanjutan: harus terakumulasi di atas penggunaan lama
    const resTool2 = await budget2.reserve({ type: "tool" });
    await budget2.reconcileToolAttempt(resTool2);

    const snap3 = budget2.getSnapshot();
    assert.equal(snap3.usage.toolSteps, 2, "toolSteps bertambah menjadi 2");
  } finally {
    conn2.close();
  }
});

test("17. Audit redaction: sensor secret, API key, authorization, dan media data URL", async () => {
  const { storage, close } = await getIsolatedStorage("test17");
  const audit = new AuditManager(storage);

  try {
    const taskId = "task_audit_test_1";
    await storage.createTask({
      task_id: taskId,
      goal: "Audit sanitization test",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "running",
    });

    await audit.recordEvent({
      eventType: "model_call",
      taskId,
      actorPn: "628111111111",
      details: {
        api_key: "sk-or-v1-supersecretkey12345678",
        authorization: "Bearer secret-token-xyz",
        media: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        safeMetadata: { durationMs: 150 },
      },
    });

    const events = await audit.getEvents({ taskId });
    assert.equal(events.length, 1);
    const details = events[0].details_redacted;

    assert.equal(details.api_key, "[REDACTED]");
    assert.equal(details.authorization, "[REDACTED]");
    assert.ok(details.media.includes("[REDACTED_DATA_URL: image/png"));
    assert.equal(details.safeMetadata.durationMs, 150);
  } finally {
    close();
  }
});

test("18. Process lock: mencegah dua instance bot bersamaan pada DB yang sama", async () => {
  const { storage, close } = await getIsolatedStorage("test18");

  try {
    const lock1 = new ProcessLock(storage, { workerId: "worker-process-1", leaseDurationMs: 5000 });
    const lock2 = new ProcessLock(storage, { workerId: "worker-process-2", leaseDurationMs: 5000 });

    // Instance 1 memperoleh lock
    await lock1.acquire();

    // Instance 2 mencoba memperoleh lock pada DB yang sama -> DITOLAK
    await assert.rejects(
      async () => {
        await lock2.acquire();
      },
      ProcessLockError,
    );

    // Instance 1 melepaskan lock saat graceful shutdown
    await lock1.release();

    // Instance 2 kini dapat memperoleh lock
    await lock2.acquire();
    await lock2.release();
  } finally {
    close();
  }
});

test("19. Shadow mode: zero external effects", async () => {
  const oldMode = process.env.RUNTIME_ENGINE_MODE;
  process.env.RUNTIME_ENGINE_MODE = "shadow";

  try {
    assert.equal(engineConfig.isShadow(), true);
    assert.equal(engineConfig.canSendExternal(), false, "Shadow dilarang mengirim ke WhatsApp");
    assert.equal(engineConfig.canWriteProductionMemory(), false, "Shadow dilarang menulis ke memori produksi");
    assert.equal(engineConfig.canScheduleProductionJobs(), false, "Shadow dilarang menjadwalkan job produksi");
  } finally {
    if (oldMode === undefined) delete process.env.RUNTIME_ENGINE_MODE;
    else process.env.RUNTIME_ENGINE_MODE = oldMode;
  }
});

test("20. Startup recovery: memulihkan task/job running yang terputus & outbox sending ke uncertain", async () => {
  const { storage, close } = await getIsolatedStorage("test20");

  try {
    const nowMs = Date.now();
    const pastMs = nowMs - 5000;

    // 1. Task yang ditinggalkan dalam status 'running' dengan lease expired
    await storage.createTask({
      task_id: "task_crashed_1",
      goal: "Crashed task",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "running",
      lease_until: pastMs,
    });

    // 2. Job yang ditinggalkan dalam status 'running' dengan lease expired
    await storage.createJob({
      job_id: "job_crashed_1",
      type: "reminder",
      fire_at: pastMs,
      payload: { phone: "628111111111" },
      status: "running",
      lease_until: pastMs,
    });

    // 3. Outbox yang ditinggalkan dalam status 'sending' dengan lease expired
    await storage.createOutboxIntent({
      outbox_id: "out_crashed_1",
      destination: "628111111111@s.whatsapp.net",
      payload: { text: "Uncommitted send" },
      idempotency_key: "idemp_crash_out",
      status: "sending",
    });
    // Set status sending dan lease_until di masa lalu
    await storage.db.execute({
      sql: "UPDATE outbox SET status = 'sending', lease_until = ? WHERE outbox_id = 'out_crashed_1';",
      args: [pastMs],
    });

    // Jalankan startup recovery
    const recoveryResult = await runStartupRecovery(storage, { nowMs });
    assert.equal(recoveryResult.recoveredTasks, 1);
    assert.equal(recoveryResult.recoveredJobs, 1);
    assert.equal(recoveryResult.reconciledOutbox, 1);

    // Cek status akhir di DB
    const t = await storage.getTask("task_crashed_1");
    assert.equal(t.status, "retry_wait", "Task running yang crash dipulihkan ke retry_wait");

    const j = await storage.getJob("job_crashed_1");
    assert.equal(j.status, "retry_wait", "Job running yang crash dipulihkan ke retry_wait");

    const o = await storage.getOutbox("out_crashed_1");
    assert.equal(o.status, "uncertain", "Outbox sending yang crash wajib dipulihkan ke uncertain!");
  } finally {
    close();
  }
});

test("21. Legacy JSON jobs importer idempotent dan tidak memodifikasi file sumber", async () => {
  const { storage, close } = await getIsolatedStorage("test21");
  const tempJobsFile = path.join(testDir, "test-legacy-jobs.json");

  const legacyData = {
    jobs: [
      { id: "legacy_job_1", type: "reminder", fire_at: 1700000000000, payload: { phone: "628111111111", text: "Test legacy" } },
      { id: "legacy_job_2", type: "reminder", fire_at: 1700000001000, payload: { phone: "628111111112", text: "Test legacy 2" } },
    ],
  };

  fs.writeFileSync(tempJobsFile, JSON.stringify(legacyData, null, 2));
  const hashBefore = fs.readFileSync(tempJobsFile, "utf8");

  try {
    // Impor pertama
    const res1 = await importLegacyJobs(storage, tempJobsFile);
    assert.equal(res1.importedCount, 2);
    assert.equal(res1.skippedCount, 0);

    // File sumber sama sekali tidak berubah
    const hashAfter1 = fs.readFileSync(tempJobsFile, "utf8");
    assert.equal(hashBefore, hashAfter1);

    // Impor kedua: idempotent (semua di-skip)
    const res2 = await importLegacyJobs(storage, tempJobsFile);
    assert.equal(res2.importedCount, 0);
    assert.equal(res2.skippedCount, 2);

    const hashAfter2 = fs.readFileSync(tempJobsFile, "utf8");
    assert.equal(hashBefore, hashAfter2);
  } finally {
    close();
  }
});
