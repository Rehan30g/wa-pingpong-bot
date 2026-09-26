const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, runtimeDb, testDir } = setupIsolatedTestEnv("wa-test-runtime-storage-");

const test = require("node:test");
const assert = require("node:assert");

test.after(() => {
  cleanup();
});

const { createStorage, runMigrations } = require("../ai/runtime/storage");
const {
  TASK_STATUS,
  TaskStore,
  InvalidStateTransitionError,
  validateTransition,
} = require("../ai/runtime/task-state-machine");
const { InboxManager, EpochStaleError } = require("../ai/runtime/inbox");
const { LeaseManager, StaleFencingTokenError, LeaseLostError } = require("../ai/runtime/lease-manager");
const { CancellationManager, ApprovalError } = require("../ai/runtime/cancellation");
const { OptimisticConcurrencyError } = require("../ai/runtime/storage");
const { DurableEgressLimiter } = require("../ai/runtime/egress-limiter");
const { routeTaskIntent } = require("../ai/runtime/intent-router");
const { createMemoryRememberCapability, createMemorySearchCapability, createMemoryCorrectCapability } = require("../ai/capabilities/memory-facts");

test("kuota egress task dan host bertahan setelah SQLite dibuka ulang", async () => {
  const dbPath = path.join(testDir, "durable-egress.db");
  let clock = 100_000;
  const first = await createStorage(dbPath);
  try {
    const limiter = new DurableEgressLimiter(first.storage, { perTask: 2, perHostPerMinute: 2, now: () => clock });
    await Promise.all([
      limiter.reserve("task-a", "https://example.org/a"),
      limiter.reserve("task-a", "https://example.org/b"),
    ]);
    await assert.rejects(limiter.reserve("task-a", "https://other.org/c"), /egress_task_quota/);
    await assert.rejects(limiter.reserve("task-b", "https://example.org/c"), /egress_host_rate_limit/);
    await assert.rejects(limiter.reserve("task-b", "http://example.org/c"), /egress_url_invalid/);
  } finally {
    await first.close();
  }
  const reopened = await createStorage(dbPath);
  try {
    const limiter = new DurableEgressLimiter(reopened.storage, { perTask: 2, perHostPerMinute: 2, now: () => clock });
    await assert.rejects(limiter.reserve("task-a", "https://other.org/c"), /egress_task_quota/);
    await assert.rejects(limiter.reserve("task-b", "https://example.org/c"), /egress_host_rate_limit/);
    clock += 60_001;
    await limiter.reserve("task-b", "https://example.org/c");
    await limiter.reserve("task-b", "https://other.org/c");
    await assert.rejects(limiter.reserve("task-b", "https://third.org/c"), /egress_task_quota/);
  } finally {
    await reopened.close();
  }
});

test("fakta bersumber dibatasi chat, expiry, epoch, reset, dan restart", async () => {
  const dbPath = path.join(testDir, "memory-facts.db");
  const chatA = "120363000000000@g.us";
  const chatB = "120363000000001@g.us";
  const phone = "628111111111";
  const first = await createStorage(dbPath);
  try {
    const fact = await first.storage.recordMemoryFact({ chatId: chatA, subjectPn: phone, sourceEntryId: "entry-1", text: "Rapat server hari Senin", confidence: 0.9, contextEpoch: 0 });
    assert.match(fact.memory_id, /^mem_/);
    const retry = await first.storage.recordMemoryFact({ chatId: chatA, subjectPn: phone, sourceEntryId: "entry-1", text: "Rapat server hari Senin", confidence: 0.9, contextEpoch: 0 });
    assert.equal(retry.memory_id, fact.memory_id, "replay sumber sama harus idempotent");
    await assert.rejects(first.storage.recordMemoryFact({ chatId: chatA, subjectPn: phone, sourceEntryId: "entry-1", text: "Klaim diganti diam-diam", contextEpoch: 0 }), /memory_fact_source_conflict/);
    assert.equal((await first.storage.searchMemoryFacts({ chatId: chatA, actorPn: phone, query: "server" })).length, 1);
    assert.equal((await first.storage.searchMemoryFacts({ chatId: chatB, actorPn: phone, query: "server" })).length, 0);
    await assert.rejects(first.storage.searchMemoryFacts({ chatId: `${phone}@s.whatsapp.net`, actorPn: "628222222222", query: "server" }), /memory_search_scope_denied/);
    await first.storage.recordMemoryFact({ chatId: chatA, subjectPn: phone, sourceEntryId: "entry-exp", text: "Fakta sementara", expiresAt: Date.now() + 10_000 });
    assert.equal((await first.storage.searchMemoryFacts({ chatId: chatA, actorPn: phone, query: "sementara", now: Date.now() + 11_000 })).length, 0);
    await first.storage.bumpChatEpoch(chatA, { reason: "clear" });
    assert.equal((await first.storage.searchMemoryFacts({ chatId: chatA, actorPn: phone, query: "server" })).length, 1, "clear hanya menghapus konteks aktif");
    await assert.rejects(first.storage.recordMemoryFact({ chatId: chatA, subjectPn: phone, sourceEntryId: "old-entry", text: "Write lama", contextEpoch: 0 }), /memory_context_epoch_stale/);
  } finally { await first.close(); }
  const reopened = await createStorage(dbPath);
  try {
    assert.equal((await reopened.storage.searchMemoryFacts({ chatId: chatA, actorPn: phone, query: "server" })).length, 1);
    await reopened.storage.bumpChatEpoch(chatA, { reason: "reset" });
    assert.equal((await reopened.storage.searchMemoryFacts({ chatId: chatA, actorPn: phone, query: "server" })).length, 0);
  } finally { await reopened.close(); }
});

test("router dan capability fakta memori menjaga sumber task serta scope chat", async () => {
  const prior = process.env.AGENT_MEMORY_FACTS_ENABLED;
  process.env.AGENT_MEMORY_FACTS_ENABLED = "true";
  const { storage, close } = await createStorage(path.join(testDir, "memory-capability.db"));
  const chatId = "120363000000003@g.us";
  const actorPn = "628123456789";
  try {
    assert.equal(routeTaskIntent("/task ingat token: rahasia"), null);
    assert.equal(routeTaskIntent("/task ingat server rapat Jumat").intent, "memory_remember");
    assert.equal(routeTaskIntent("/task cari memori server").intent, "memory_search");
    const task = await storage.createTask({ goal: "Ingat fakta: server rapat Jumat", actor_pn: actorPn, chat_id: chatId, source_event_id: "wa-entry-1", scope: "active_chat,write", context_epoch: 0 });
    const context = { taskId: task.task_id, originChatId: chatId, actor: { id: actorPn } };
    const remember = createMemoryRememberCapability({ storage });
    const first = await remember.handler({}, context);
    assert.equal((await remember.verifier(first, context)).ok, true);
    assert.equal((await remember.handler({}, context)).memory_id, first.memory_id);
    const search = createMemorySearchCapability({ storage });
    const found = await search.handler({ query: "server" }, context);
    assert.equal(found.facts[0].source_entry_id, "wa-entry-1");
    assert.equal((await search.verifier(found, context)).ok, true);
    assert.equal((await search.verifier({ facts: [{ ...found.facts[0], text: "sisipan palsu" }] }, context)).ok, false);
    assert.deepEqual((await search.handler({ query: "server" }, { ...context, originChatId: "120363000000004@g.us" })).facts, []);
    await assert.rejects(remember.handler({}, { ...context, originChatId: "120363000000004@g.us" }), /memory_source_denied/);
    const correctionRoute = routeTaskIntent(`/task koreksi memori ${first.memory_id}: server rapat Sabtu`);
    assert.equal(correctionRoute.intent, "memory_correct");
    const correctionTask = await storage.createTask({ goal: correctionRoute.goal, actor_pn: actorPn, chat_id: chatId, source_event_id: "wa-entry-2", scope: "active_chat,write", context_epoch: 0 });
    const correctionContext = { ...context, taskId: correctionTask.task_id };
    const correct = createMemoryCorrectCapability({ storage });
    const corrected = await correct.handler({}, correctionContext);
    assert.equal((await correct.verifier(corrected, correctionContext)).ok, true);
    assert.equal((await correct.handler({}, correctionContext)).memory_id, corrected.memory_id, "koreksi replay idempotent");
    assert.equal((await search.handler({ query: "Jumat" }, context)).facts.length, 0);
    assert.equal((await search.handler({ query: "Sabtu" }, context)).facts[0].memory_id, corrected.memory_id);
    const otherActor = await storage.createTask({ goal: correctionRoute.goal, actor_pn: "628999999999", chat_id: chatId, source_event_id: "wa-entry-3", scope: "active_chat,write", context_epoch: 0 });
    await assert.rejects(correct.handler({}, { ...context, taskId: otherActor.task_id, actor: { id: "628999999999" } }), /memory_correction_scope_denied/);
  } finally {
    if (prior === undefined) delete process.env.AGENT_MEMORY_FACTS_ENABLED;
    else process.env.AGENT_MEMORY_FACTS_ENABLED = prior;
    await close();
  }
});

test("fakta berkunci yang bertentangan tetap tampil sebagai konflik sampai bukti koreksi", async () => {
  const { storage, close } = await createStorage(path.join(testDir, "memory-conflict.db"));
  const chatId = "120363000000005@g.us";
  const subjectPn = "628123456789";
  try {
    const first = await storage.recordMemoryFact({ chatId, subjectPn, sourceEntryId: "entry-a", text: "Jadwal rapat: Jumat", contextEpoch: 0 });
    const second = await storage.recordMemoryFact({ chatId, subjectPn, sourceEntryId: "entry-b", text: "Jadwal rapat: Sabtu", contextEpoch: 0 });
    let found = await storage.searchMemoryFacts({ chatId, actorPn: subjectPn, query: "rapat" });
    assert.equal(found.length, 2);
    assert.deepEqual(new Set(found.map((fact) => fact.status)), new Set(["conflicted"]));
    assert.deepEqual(new Set(found.map((fact) => fact.source_entry_id)), new Set(["entry-a", "entry-b"]));
    assert.equal((await storage.getMemoryFact(first.memory_id, chatId)).status, "conflicted");
    await assert.rejects(storage.correctMemoryFact({ memoryId: first.memory_id, chatId, subjectPn, sourceEntryId: "entry-c", text: "Lokasi rapat: kantor", contextEpoch: 0 }), /memory_correction_topic_mismatch/);
    const corrected = await storage.correctMemoryFact({ memoryId: first.memory_id, chatId, subjectPn, sourceEntryId: "entry-c", text: "Jadwal rapat: Sabtu", contextEpoch: 0 });
    assert.equal(corrected.version, 2);
    found = await storage.searchMemoryFacts({ chatId, actorPn: subjectPn, query: "rapat" });
    assert.equal(found.some((fact) => fact.memory_id === first.memory_id), false);
    assert.equal(found.some((fact) => fact.memory_id === second.memory_id), true);
    assert.equal(found.some((fact) => fact.memory_id === corrected.memory_id), true);
  } finally { await close(); }
});

async function getIsolatedStorage(testName) {
  const dbPath = path.join(testDir, `${testName}.db`);
  return createStorage(dbPath);
}

test("1. Migrations bersifat idempotent", async () => {
  const { storage, db, close } = await getIsolatedStorage("test1");
  try {
    const res1 = await runMigrations(db);
    assert.equal(res1.appliedCount, 0, "Migrasi kedua kali harus menerapkan 0 skema baru");
    assert.equal(res1.currentVersion, 3);

    // Cek bahwa tabel-tabel utama ada
    const tablesRes = await db.execute("SELECT name FROM sqlite_master WHERE type='table';");
    const tableNames = new Set(tablesRes.rows.map((r) => r.name));
    const required = [
      "schema_version",
      "tasks",
      "task_steps",
      "inbox_events",
      "jobs",
      "approvals",
      "outbox",
      "idempotency_records",
      "budget_ledger",
      "audit_events",
      "worker_leases",
      "chat_context_epochs",
    ];
    for (const t of required) {
      assert.ok(tableNames.has(t), `Tabel ${t} wajib ada`);
    }
  } finally {
    close();
  }
});

test("2. Validasi transisi status task: transisi ilegal ditolak, terminal tidak dibuka ulang", async () => {
  const { storage, close } = await getIsolatedStorage("test2");
  const taskStore = new TaskStore(storage);

  try {
    const task = await taskStore.createTask({
      goal: "Kirim stiker ke grup",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      scope: "active_chat",
    });
    assert.equal(task.status, TASK_STATUS.QUEUED);

    // Transisi ilegal: queued -> succeeded langsung
    assert.throws(
      () => validateTransition(TASK_STATUS.QUEUED, TASK_STATUS.SUCCEEDED),
      InvalidStateTransitionError,
    );

    // Transisi sah: queued -> running -> verifying -> succeeded
    const t1 = await taskStore.transitionTask(task.task_id, TASK_STATUS.RUNNING);
    assert.equal(t1.status, TASK_STATUS.RUNNING);

    const t2 = await taskStore.transitionTask(task.task_id, TASK_STATUS.VERIFYING);
    assert.equal(t2.status, TASK_STATUS.VERIFYING);

    const t3 = await taskStore.transitionTask(task.task_id, TASK_STATUS.SUCCEEDED);
    assert.equal(t3.status, TASK_STATUS.SUCCEEDED);

    // Terminal state tidak bisa berpindah ke mana pun
    assert.throws(
      () => validateTransition(TASK_STATUS.SUCCEEDED, TASK_STATUS.RUNNING),
      InvalidStateTransitionError,
    );
    await assert.rejects(
      async () => taskStore.transitionTask(task.task_id, TASK_STATUS.QUEUED),
      InvalidStateTransitionError,
    );

    // Resume waiting state melalui queued
    const waitingTask = await taskStore.createTask({
      goal: "Tunggu input pengguna",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
    });
    await taskStore.transitionTask(waitingTask.task_id, TASK_STATUS.RUNNING);
    await taskStore.transitionTask(waitingTask.task_id, TASK_STATUS.WAITING_INPUT);

    // Ilegal jika langsung ke succeeded
    await assert.rejects(
      async () => taskStore.transitionTask(waitingTask.task_id, TASK_STATUS.SUCCEEDED),
      InvalidStateTransitionError,
    );

    // Sah via resumeTask (menghasilkan queued)
    const resumed = await taskStore.resumeTask(waitingTask.task_id);
    assert.equal(resumed.status, TASK_STATUS.QUEUED);
  } finally {
    close();
  }
});

test("3. Optimistic concurrency conflict pada update task", async () => {
  const { storage, close } = await getIsolatedStorage("test3");
  try {
    const task = await storage.createTask({
      goal: "Optimistic concurrency test",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "queued",
    });
    assert.equal(task.version, 1);

    // Worker A mengupdate dengan expectedVersion = 1 -> Sukses, versi naik jadi 2
    const updatedA = await storage.updateTask(task.task_id, {
      expectedVersion: 1,
      status: "running",
    });
    assert.equal(updatedA.version, 2);

    // Worker B mencoba update dengan expectedVersion = 1 yang sudah basi -> Ditolak
    await assert.rejects(
      async () => {
        await storage.updateTask(task.task_id, {
          expectedVersion: 1,
          status: "cancelled",
        });
      },
      OptimisticConcurrencyError,
    );
  } finally {
    close();
  }
});

test("4. Inbox deduplication: event ganda tidak membuat task baru", async () => {
  const { storage, close } = await getIsolatedStorage("test4");
  const inbox = new InboxManager(storage);

  try {
    const eventParams = {
      transport: "baileys",
      chatId: "chat_inbox_dedup@g.us",
      participantPn: "628111111111",
      sourceEventId: "MSG_UNIQUE_12345",
      payload: { text: "Halo bot, tolong buatkan jadwal" },
      taskIntent: { goal: "Buat jadwal" },
    };

    // Panggilan pertama: berhasil memasukkan event dan enqueue task
    const res1 = await inbox.processInboundEvent(eventParams);
    assert.equal(res1.duplicate, false);
    assert.ok(res1.task);
    assert.equal(res1.task.goal, "Buat jadwal");

    // Panggilan kedua dengan parameter identik: terdeteksi duplikat!
    const res2 = await inbox.processInboundEvent(eventParams);
    assert.equal(res2.duplicate, true);
    assert.equal(res2.task, null);

    // Pastikan tabel tasks hanya memiliki tepat 1 task
    const tasks = await storage.listTasks({ chatId: "chat_inbox_dedup@g.us" });
    assert.equal(tasks.length, 1);
  } finally {
    close();
  }
});

test("5. Penolakan ketat identitas raw LID (PN vs LID refusal)", async () => {
  const { storage, close } = await getIsolatedStorage("test5");
  const inbox = new InboxManager(storage);
  const taskStore = new TaskStore(storage);

  try {
    // Inbox menolak participant_pn berformat LID
    await assert.rejects(
      async () => {
        await inbox.processInboundEvent({
          transport: "baileys",
          chatId: "120363000000000@g.us",
          participantPn: "999654321012345@lid",
          sourceEventId: "MSG_LID_999",
        });
      },
      /Raw WhatsApp LID ditolak/,
    );

    // TaskStore menolak actor_pn berformat LID
    await assert.rejects(
      async () => {
        await taskStore.createTask({
          goal: "Task ilegal dari LID",
          actor_pn: "999654321012345.lid",
          chat_id: "120363000000000@g.us",
        });
      },
      /bukan raw WhatsApp LID/,
    );
  } finally {
    close();
  }
});

test("6. Dua worker berebut task yang sama: hanya satu yang berhasil klaim", async () => {
  const dbPath = path.join(testDir, "test6.db");
  const conn1 = await createStorage(dbPath);
  const conn2 = await createStorage(dbPath);
  const leaseManager1 = new LeaseManager(conn1.storage);
  const leaseManager2 = new LeaseManager(conn2.storage);

  try {
    const task = await conn1.storage.createTask({
      goal: "Rebutan task dua worker",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "queued",
    });

    // Dua worker independen memanggil claimTask secara konkuren
    const [claim1, claim2] = await Promise.all([
      leaseManager1.claimTask(task.task_id, { workerId: "worker-alpha", leaseDurationMs: 10000 }),
      leaseManager2.claimTask(task.task_id, { workerId: "worker-beta", leaseDurationMs: 10000 }),
    ]);

    const successes = [claim1, claim2].filter(Boolean);
    assert.equal(successes.length, 1, "Tepat satu worker yang berhasil claim task");
    assert.equal(successes[0].claimed, true);

    const taskInDb = await conn1.storage.getTask(task.task_id);
    assert.equal(taskInDb.status, "running");
    assert.equal(taskInDb.worker_id, successes[0].workerId);
    assert.equal(taskInDb.fencing_token, 1);
  } finally {
    conn1.close();
    conn2.close();
  }
});

test("7. Stale fencing token ditolak setelah lease takeover", async () => {
  const { storage, close } = await getIsolatedStorage("test7");
  const leaseManager = new LeaseManager(storage);

  try {
    const task = await storage.createTask({
      goal: "Fencing token stale test",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "queued",
    });

    // Worker 1 klaim task (fencing token = 1) dengan durasi lease sangat pendek
    const claim1 = await leaseManager.claimTask(task.task_id, { workerId: "worker-1", leaseDurationMs: 30 });
    assert.equal(claim1.fencingToken, 1);

    // Tunggu lease worker-1 kedaluwarsa
    await new Promise((r) => setTimeout(r, 60));

    // Worker 2 mengambil alih (takeover) task yang expired (fencing token = 2)
    const claim2 = await leaseManager.claimTask(task.task_id, { workerId: "worker-2", leaseDurationMs: 10000 });
    assert.equal(claim2.fencingToken, 2);

    // Worker 1 yang lama mencoba checkpoint dengan fencing token = 1 -> WAJIB DITOLAK!
    await assert.rejects(
      async () => {
        await leaseManager.checkpointTask(task.task_id, {
          workerId: "worker-1",
          fencingToken: 1,
          updates: { budget_snapshot: { steps: 2 } },
        });
      },
      LeaseLostError,
    );

    // Worker 2 dengan fencing token = 2 sah melakukan checkpoint
    const checkpoint2 = await leaseManager.checkpointTask(task.task_id, {
      workerId: "worker-2",
      fencingToken: 2,
      updates: { budget_snapshot: { steps: 3 } },
    });
    assert.equal(checkpoint2.budget_snapshot.steps, 3);
  } finally {
    close();
  }
});

test("8. Lease expiry takeover: worker baru dapat merebut task saat lease expired", async () => {
  const { storage, close } = await getIsolatedStorage("test8");
  const leaseManager = new LeaseManager(storage);

  try {
    const task = await storage.createTask({
      goal: "Takeover test",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "queued",
    });

    // Worker-A klaim 50ms
    await leaseManager.claimTask(task.task_id, { workerId: "worker-A", leaseDurationMs: 50 });

    // Worker-B mencoba merebut saat lease masih aktif -> gagal
    const failedClaim = await leaseManager.claimTask(task.task_id, { workerId: "worker-B", leaseDurationMs: 10000 });
    assert.equal(failedClaim, null);

    // Tunggu hingga lease expired
    await new Promise((r) => setTimeout(r, 70));

    // Worker-B merebut -> berhasil
    const successfulClaim = await leaseManager.claimTask(task.task_id, { workerId: "worker-B", leaseDurationMs: 10000 });
    assert.ok(successfulClaim);
    assert.equal(successfulClaim.workerId, "worker-B");
    assert.equal(successfulClaim.fencingToken, 2);
  } finally {
    close();
  }
});

test("9. Restart persistence: data bertahan saat database dibuka ulang dari koneksi baru", async () => {
  const dbPath = path.join(testDir, "test9.db");
  const conn1 = await createStorage(dbPath);
  const taskId = "task_restart_test_99";
  try {
    await conn1.storage.createTask({
      task_id: taskId,
      goal: "Data persistence across restart",
      actor_pn: "628111111111",
      chat_id: "120363000000000@g.us",
      status: "running",
      plan_version: 2,
    });
    await conn1.storage.createTaskStep({
      step_id: "step_99_1",
      task_id: taskId,
      step_index: 1,
      capability_name: "note_create",
      logical_operation_id: "op_1",
      idempotency_key: "idemp_abc123",
      status: "succeeded",
      evidence: "Note saved to disk",
    });
  } finally {
    conn1.close();
  }

  // Buka koneksi baru (simulasi restart proses)
  const conn2 = await createStorage(dbPath);
  try {
    const reloadedTask = await conn2.storage.getTask(taskId);
    assert.ok(reloadedTask);
    assert.equal(reloadedTask.goal, "Data persistence across restart");
    assert.equal(reloadedTask.plan_version, 2);

    const reloadedSteps = await conn2.storage.getTaskSteps(taskId);
    assert.equal(reloadedSteps.length, 1);
    assert.equal(reloadedSteps[0].step_id, "step_99_1");
    assert.equal(reloadedSteps[0].evidence, "Note saved to disk");
  } finally {
    conn2.close();
  }
});

test("10. Cancel / context epoch: penolakan write lama saat epoch dinaikkan", async () => {
  const { storage, close } = await getIsolatedStorage("test10");
  const inbox = new InboxManager(storage);
  const cancellation = new CancellationManager(storage);

  const chatId = "120363000000000@g.us";
  try {
    const epoch0 = inbox.getChatEpoch(chatId);
    assert.equal(epoch0, 0);

    // Simulasi pengguna mengirim /clear -> bump context epoch
    const epoch1 = inbox.bumpChatEpoch(chatId);
    assert.equal(epoch1, 1);

    // Efek samping dengan epoch 0 wajib ditolak!
    assert.throws(
      () => inbox.verifyEpoch(chatId, 0),
      EpochStaleError,
    );

    // Efek samping dengan epoch 1 diterima
    assert.equal(inbox.verifyEpoch(chatId, 1), true);

    // CancellationManager juga memvalidasi epoch
    cancellation.bumpEpoch(chatId);
    assert.throws(
      () => cancellation.verifyEpoch(chatId, 0),
      /Context epoch kadaluwarsa/,
    );
  } finally {
    close();
  }
});

test("11. Idempotency exact match dan pencegahan duplikasi eksekusi", async () => {
  const { storage, close } = await getIsolatedStorage("test11");
  const cancellation = new CancellationManager(storage);

  try {
    const key = cancellation.buildKey({
      taskId: "task_demo",
      capabilityName: "note_create",
      logicalOperationId: "step_1",
    });

    // Cek pertama: belum pernah dieksekusi
    const check1 = await cancellation.checkIdempotency(key);
    assert.equal(check1.alreadyExecuted, false);

    // Simpan hasil eksekusi
    await cancellation.recordIdempotency(key, {
      taskId: "task_demo",
      capabilityName: "note_create",
      logicalOperationId: "step_1",
      result: { noteId: "note_123", success: true },
    });

    // Cek kedua: sudah dieksekusi, mengembalikan hasil tersimpan
    const check2 = await cancellation.checkIdempotency(key);
    assert.equal(check2.alreadyExecuted, true);
    assert.equal(check2.result.noteId, "note_123");

    // Argumen atau stepId berbeda menghasilkan key yang berbeda
    const keyOther = cancellation.buildKey({
      taskId: "task_demo",
      capabilityName: "note_create",
      logicalOperationId: "step_2",
    });
    assert.notEqual(key, keyOther);
    const checkOther = await cancellation.checkIdempotency(keyOther);
    assert.equal(checkOther.alreadyExecuted, false);
  } finally {
    close();
  }
});

test("12. Persetujuan sensitif (Approvals): hash argumen, expiry, dan single-use", async () => {
  const { storage, close } = await getIsolatedStorage("test12");
  const cancellation = new CancellationManager(storage);

  try {
    const taskId = "task_sensitive_1";
    const actorPn = "628111111111";
    const capabilityName = "delete_file";
    const logicalOperationId = "op_del_1";
    const originalArgs = { filename: "report.pdf", force: false };

    // Buat task terlebih dahulu untuk memenuhi foreign key constraint
    await storage.createTask({
      task_id: taskId,
      goal: "Hapus file sensitif",
      actor_pn: actorPn,
      chat_id: "120363000000000@g.us",
      status: "running",
    });

    // Buat approval dengan masa berlaku 1 detik
    await cancellation.grantApproval({
      taskId,
      actorPn,
      capabilityName,
      logicalOperationId,
      args: originalArgs,
      expiresInMs: 1000,
    });

    // A. Argumen berubah sekecil apa pun -> ditolak!
    await assert.rejects(
      async () => {
        await cancellation.verifyAndConsumeApproval({
          taskId,
          actorPn,
          capabilityName,
          logicalOperationId,
          args: { filename: "report.pdf", force: true }, // force diubah!
        });
      },
      ApprovalError,
    );

    // B. Argumen sama persis -> sukses dan status menjadi 'used'
    const consumed = await cancellation.verifyAndConsumeApproval({
      taskId,
      actorPn,
      capabilityName,
      logicalOperationId,
      args: originalArgs,
    });
    assert.ok(consumed);

    // C. Single-use: pemanggilan kedua dengan argumen yang sama ditolak!
    await assert.rejects(
      async () => {
        await cancellation.verifyAndConsumeApproval({
          taskId,
          actorPn,
          capabilityName,
          logicalOperationId,
          args: originalArgs,
        });
      },
      ApprovalError,
    );

    // D. Expiry: buat approval dengan durasi 10ms lalu tunggu hingga expired
    await cancellation.grantApproval({
      taskId,
      actorPn,
      capabilityName,
      logicalOperationId: "op_expired",
      args: originalArgs,
      expiresInMs: 20,
    });
    await new Promise((r) => setTimeout(r, 40));
    await assert.rejects(
      async () => {
        await cancellation.verifyAndConsumeApproval({
          taskId,
          actorPn,
          capabilityName,
          logicalOperationId,
          args: originalArgs,
        });
      },
      ApprovalError,
    );
  } finally {
    close();
  }
});
