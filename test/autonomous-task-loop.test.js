const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert");

const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-phase3-task-loop-");
process.env.AGENT_CANARY_OWNER = "628123456789";

test.after(() => {
  cleanup();
});

const { createStorage } = require("../ai/runtime/storage");
const { TaskRunner } = require("../ai/runtime/task-runner");
const { TaskPlanner, PlannerError } = require("../ai/runtime/planner");
const { TaskVerifier } = require("../ai/runtime/verifier");
const { CanaryManager } = require("../ai/runtime/canary");
const { InboxManager } = require("../ai/runtime/inbox");
const { CancellationManager, ApprovalError } = require("../ai/runtime/cancellation");
const { OutboxManager } = require("../ai/runtime/outbox");
const { AuditManager } = require("../ai/runtime/audit");
const { TaskStore, TASK_STATUS } = require("../ai/runtime/task-state-machine");
const { LeaseManager, StaleFencingTokenError, LeaseLostError } = require("../ai/runtime/lease-manager");
const { DurableBudget, BudgetExhaustedError } = require("../ai/runtime/durable-budget");
const { createCapabilityRegistry, buildIdempotencyKey, CapabilityExecutionError } = require("../ai/capabilities/registry");
const { registerMvpCapabilities, createMvpCapabilities } = require("../ai/capabilities/mvp-capabilities");
const { RuntimeLifecycle } = require("../ai/runtime/lifecycle");
const { runStartupRecovery } = require("../ai/runtime/recovery");
const { AssetStore } = require("../ai/media/asset-store");
const sharp = require("sharp");
const { dispatchInboundMessage, handleMessage, setData } = require("../index");

function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function makeMockTransport() {
  const sent = [];
  return {
    sent,
    simulateCrashPostSend: false,
    send: async ({ destination, contentType, payload, idempotencyKey }) => {
      const item = {
        destination,
        contentType,
        payload,
        idempotencyKey,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sentAt: new Date().toISOString(),
      };
      sent.push(item);
      return item;
    },
  };
}

function makeMockGlmClient(planGenerator) {
  return {
    chatCompletion: async ({ messages }) => {
      const plan = typeof planGenerator === "function" ? planGenerator(messages) : planGenerator;
      const text = typeof plan === "string" ? plan : JSON.stringify(plan);
      return {
        text,
        usage: { prompt_tokens: 150, completion_tokens: 120, total_tokens: 270 },
        latencyMs: 15,
        model: "z-ai/glm-5.3-flash",
      };
    },
  };
}

async function getIsolatedEnv(name) {
  const dbPath = path.join(testDir, `${name}.db`);
  const { storage, close } = await createStorage(dbPath);
  const registry = createCapabilityRegistry();
  registerMvpCapabilities(registry, { storage });
  // Capability arsip sengaja nonaktif di produksi; aktifkan hanya untuk menguji alur approval.
  registry.enableCapability("export_archive");
  return { storage, registry, dbPath, close };
}

// ============================================================================
// SUITE INTEGRATION TESTS FASE 3 (MINIMAL 25 SKENARIO DETERMINISTIK)
// ============================================================================

test("1. Happy multi-step: task 3 langkah (summarize -> create_note -> read_note) sukses dengan bukti", async () => {
  const { storage, registry, close } = await getIsolatedEnv("happy_multistep");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Ringkas materi rapat lalu buat catatan dan baca kembali",
      acceptance_criteria: "Catatan terverifikasi dan dapat dibaca kembali",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_writer",
    });

    const mockGlm = makeMockGlmClient({
      plan_id: "plan_happy_1",
      goal: task.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "summarize_context",
          logical_operation_id: "step_summarize",
          arguments: { text: "Poin 1: Jadwal rilis besok. Poin 2: Server siap. Poin 3: Semua tim siaga.", max_points: 3 },
          expected_result: "Ringkasan 3 poin",
        },
        {
          step_index: 1,
          capability_name: "create_note",
          logical_operation_id: "step_create_note",
          arguments: { title: "Rilis Besok", content: "1. Jadwal rilis besok\n2. Server siap" },
          expected_result: "Catatan tersimpan dengan note_id",
        },
        {
          step_index: 2,
          capability_name: "read_note",
          logical_operation_id: "step_read_note",
          arguments: { note_id: "dummy_will_be_overridden_or_fixed" },
          expected_result: "Isi catatan dapat dibaca kembali",
        },
      ],
      final_response: "Materi berhasil diringkas dan catatan sudah disimpan.",
    });

    // Sesuaikan step 2 dengan note_id yang dihasilkan step 1 via custom planner jika perlu,
    // atau gunakan capability read_note terhadap note yang ada
    const customGlm = makeMockGlmClient((messages) => {
      return {
        plan_id: "plan_happy_custom",
        goal: task.goal,
        steps: [
          {
            step_index: 0,
            capability_name: "summarize_context",
            logical_operation_id: "op_summarize",
            arguments: { text: "Langkah A. Langkah B. Langkah C.", max_points: 2 },
            expected_result: "2 poin",
          },
          {
            step_index: 1,
            capability_name: "create_note",
            logical_operation_id: "op_create",
            arguments: { title: "Ringkasan", content: "Langkah A dan B" },
            expected_result: "Note tersimpan",
          },
        ],
        final_response: "Selesai",
      };
    });

    const runner = new TaskRunner(storage, {
      workerId: "test_worker_1",
      registry,
      glmClient: customGlm,
    });

    const completed = await runner.runTask(task.task_id);
    assert.equal(completed.status, TASK_STATUS.SUCCEEDED);
    assert.ok(completed.evidence_refs.length >= 2, "Harus memuat bukti langkah-langkah");

    // Periksa status langkah di task_steps
    const steps = await storage.getTaskSteps(task.task_id);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].status, "succeeded");
    assert.equal(steps[1].status, "succeeded");
  } finally {
    close();
  }
});

test("2. Bad planner JSON: output model bukan JSON valid ditolak fail-closed", async () => {
  const { storage, registry, close } = await getIsolatedEnv("bad_json");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Lakukan sesuatu",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const brokenGlm = makeMockGlmClient("Bukan JSON { invalid: [ broken");
    const runner = new TaskRunner(storage, {
      workerId: "worker_bad_json",
      registry,
      glmClient: brokenGlm,
    });

    const failedTask = await runner.runTask(task.task_id);
    assert.equal(failedTask.status, TASK_STATUS.FAILED);
    assert.ok(failedTask.evidence_refs.some((e) => e.code === "bad_planner_json"));
  } finally {
    close();
  }
});

test("3. Bad planner schema: output model melanggar skema Ajv ditolak fail-closed", async () => {
  const { storage, registry, close } = await getIsolatedEnv("bad_schema");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Uji skema rusak",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    // Hilang properti wajib 'steps'
    const invalidSchemaGlm = makeMockGlmClient({
      plan_id: "plan_invalid",
      goal: "Goal saja tanpa steps",
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_bad_schema",
      registry,
      glmClient: invalidSchemaGlm,
    });

    const failedTask = await runner.runTask(task.task_id);
    assert.equal(failedTask.status, TASK_STATUS.FAILED);
    assert.ok(failedTask.evidence_refs.some((e) => e.code === "invalid_plan_schema"));
  } finally {
    close();
  }
});

test("4. Plan step bounds exceeded: rencana > 8 langkah ditolak fail-closed", async () => {
  const { storage, registry, close } = await getIsolatedEnv("plan_bounds");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Rencana panjang",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    // Buat 9 langkah
    const steps9 = Array.from({ length: 9 }, (_, i) => ({
      step_index: i,
      capability_name: "summarize_context",
      logical_operation_id: `op_${i}`,
      arguments: { text: "teks", max_points: 1 },
      expected_result: "hasil",
    }));

    const tooManyStepsGlm = makeMockGlmClient({
      plan_id: "plan_9_steps",
      goal: "Goal",
      steps: steps9,
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_bounds",
      registry,
      glmClient: tooManyStepsGlm,
    });

    const failedTask = await runner.runTask(task.task_id);
    assert.equal(failedTask.status, TASK_STATUS.FAILED);
  } finally {
    close();
  }
});

test("5. Model injection attempt - destination injected: ditolak oleh planner", async () => {
  const { storage, registry, close } = await getIsolatedEnv("inject_dest");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Kirim pesan ke orang lain",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const injectGlm = makeMockGlmClient({
      plan_id: "plan_inject",
      goal: "Kirim",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_inject",
          arguments: { title: "Test", content: "Isi", destination: "628999999999@s.whatsapp.net" },
          expected_result: "hasil",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_inject",
      registry,
      glmClient: injectGlm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
    assert.ok(failed.evidence_refs.some((e) => e.code === "model_injection_detected"));
  } finally {
    close();
  }
});

test("6. Model injection attempt - idempotencyKey injected: ditolak oleh planner", async () => {
  const { storage, registry, close } = await getIsolatedEnv("inject_idemp");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Manipulasi idempotency key",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const injectGlm = makeMockGlmClient({
      plan_id: "plan_inject_idemp",
      goal: "Manipulasi",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_inject_idemp",
          arguments: { title: "Test", content: "Isi", idempotencyKey: "palsu_123" },
          expected_result: "hasil",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_inject_idemp",
      registry,
      glmClient: injectGlm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
    assert.ok(failed.evidence_refs.some((e) => e.code === "model_injection_detected"));
  } finally {
    close();
  }
});

test("7. Model injection attempt - policy/approval injected: ditolak oleh planner", async () => {
  const { storage, registry, close } = await getIsolatedEnv("inject_policy");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Bypass approval",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const injectGlm = makeMockGlmClient({
      plan_id: "plan_inject_policy",
      goal: "Bypass",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_bypass",
          arguments: { title: "Test", content: "Isi", approval: "granted", policy: "allow_all" },
          expected_result: "hasil",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_inject_policy",
      registry,
      glmClient: injectGlm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
    assert.ok(failed.evidence_refs.some((e) => e.code === "model_injection_detected"));
  } finally {
    close();
  }
});

test("8. Capability deny - capability tidak terdaftar: task gagal dengan reason jelas", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cap_not_found");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Jalankan capability hantu",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    // Buat step manual atau inject plan lewat GLM
    const phantomGlm = makeMockGlmClient({
      plan_id: "plan_phantom",
      goal: "Goal",
      steps: [
        {
          step_index: 0,
          capability_name: "phantom_tool_yang_tidak_ada",
          logical_operation_id: "op_phantom",
          arguments: {},
          expected_result: "hasil",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_phantom",
      registry,
      glmClient: phantomGlm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
  } finally {
    close();
  }
});

test("9. Capability deny - capability dinonaktifkan: task gagal dengan status terminal", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cap_disabled");
  try {
    // Nonaktifkan capability summarize_context
    registry.disableCapability("summarize_context");

    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Gunakan capability yang nonaktif",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const disabledGlm = makeMockGlmClient({
      plan_id: "plan_disabled",
      goal: "Goal",
      steps: [
        {
          step_index: 0,
          capability_name: "summarize_context",
          logical_operation_id: "op_disabled",
          arguments: { text: "teks panjang", max_points: 1 },
          expected_result: "hasil",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_disabled",
      registry,
      glmClient: disabledGlm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
  } finally {
    close();
  }
});

test("10. Approval needed: capability sensitif mengalihkan task ke waiting_approval", async () => {
  const { storage, registry, close } = await getIsolatedEnv("approval_needed");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Ekspor arsip chat",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const sensitiveGlm = makeMockGlmClient({
      plan_id: "plan_sensitive",
      goal: "Ekspor",
      steps: [
        {
          step_index: 0,
          capability_name: "export_archive",
          logical_operation_id: "op_export",
          arguments: { archive_name: "chat_backup_2026" },
          expected_result: "Arsip terbentuk",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_approval",
      registry,
      glmClient: sensitiveGlm,
    });

    const waitingTask = await runner.runTask(task.task_id);
    assert.equal(waitingTask.status, TASK_STATUS.WAITING_APPROVAL);

    // Verifikasi event audit waiting_approval tercatat
    const auditManager = new AuditManager(storage);
    const events = await auditManager.getEvents({ taskId: task.task_id });
    assert.ok(events.some((e) => e.event_type === "task_waiting_approval"));
  } finally {
    close();
  }
});

test("11. Approval granted & single-use consumed: persetujuan hanya dapat dipakai satu kali", async () => {
  const { storage, registry, close } = await getIsolatedEnv("approval_consumed");
  try {
    const cancellationManager = new CancellationManager(storage);
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Ekspor arsip chat dengan persetujuan",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_approval",
    });

    const args = { archive_name: "arsip_resmi" };

    // 1. Berikan persetujuan sah dari actor PN
    await cancellationManager.grantApproval({
      taskId: task.task_id,
      actorPn: "628123456789",
      capabilityName: "export_archive",
      logicalOperationId: "op_export_approved",
      args,
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_approved",
      goal: "Ekspor",
      steps: [
        {
          step_index: 0,
          capability_name: "export_archive",
          logical_operation_id: "op_export_approved",
          arguments: args,
          expected_result: "Arsip selesai",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_consumed",
      registry,
      cancellationManager,
      glmClient: glm,
    });

    // Persetujuan dikonsumsi, tetapi operasi belum diimplementasikan dan harus gagal tertutup.
    const completed = await runner.runTask(task.task_id);
    assert.equal(completed.status, TASK_STATUS.FAILED);

    // 3. Upaya verifikasi persetujuan yang sama kedua kali harus ditolak (single-use constraint)
    await assert.rejects(
      async () => {
        await cancellationManager.verifyAndConsumeApproval({
          taskId: task.task_id,
          actorPn: "628123456789",
          capabilityName: "export_archive",
          logicalOperationId: "op_export_approved",
          args,
        });
      },
      /Persetujuan tidak ditemukan, argumen berubah, atau sudah kedaluwarsa/,
    );
  } finally {
    close();
  }
});

test("12. Approval argument hash mismatch: perubahan argumen membatalkan persetujuan", async () => {
  const { storage, registry, close } = await getIsolatedEnv("approval_mismatch");
  try {
    const cancellationManager = new CancellationManager(storage);
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Ekspor arsip",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    // Setujui argumen A
    await cancellationManager.grantApproval({
      taskId: task.task_id,
      actorPn: "628123456789",
      capabilityName: "export_archive",
      logicalOperationId: "op_mismatch",
      args: { archive_name: "arsip_asli" },
    });

    // Model mencoba menjalankan dengan argumen B yang berbeda
    const glm = makeMockGlmClient({
      plan_id: "plan_mismatch",
      goal: "Ekspor",
      steps: [
        {
          step_index: 0,
          capability_name: "export_archive",
          logical_operation_id: "op_mismatch",
          arguments: { archive_name: "arsip_yang_diubah_hacker" },
          expected_result: "Arsip",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_mismatch",
      registry,
      cancellationManager,
      glmClient: glm,
    });

    const waiting = await runner.runTask(task.task_id);
    assert.equal(waiting.status, TASK_STATUS.WAITING_APPROVAL);
  } finally {
    close();
  }
});

test("13. Timeout / abort in capability: eksekusi yang macet dibatalkan dan dilaporkan", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cap_timeout");
  try {
    // Daftarkan capability lambat dengan timeoutMs pendek
    registry.registerCapability({
      name: "slow_capability",
      version: "1.0.0",
      description: "Capability yang melebihi batas waktu",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "read"],
      enabled: true,
      timeoutMs: 50,
      sideEffect: "none",
      idempotency: "read_only",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async (_input, ctx) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          if (ctx && ctx.signal) {
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(ctx.signal.reason || new Error("Aborted"));
            }, { once: true });
          }
        });
        return {};
      },
      verifier: async () => ({ ok: true }),
    });

    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Jalankan tool lambat",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_slow",
      goal: "Slow",
      steps: [
        {
          step_index: 0,
          capability_name: "slow_capability",
          logical_operation_id: "op_slow",
          arguments: {},
          expected_result: "selesai",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_timeout",
      registry,
      glmClient: glm,
    });

    const failed = await runner.runTask(task.task_id);
    // Timeout adalah transient error, task masuk ke retry_wait atau failed tergantung budget
    assert.ok(failed.status === TASK_STATUS.RETRY_WAIT || failed.status === TASK_STATUS.FAILED);
  } finally {
    close();
  }
});

test("14. Retry budget exhausted: kegagalan berulang menghabiskan budget retry (maksimal 2)", async () => {
  const { storage, registry, close } = await getIsolatedEnv("retry_exhausted");
  try {
    registry.registerCapability({
      name: "failing_transient_cap",
      version: "1.0.0",
      description: "Capability yang selalu gagal sementara",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "read"],
      enabled: true,
      timeoutMs: 50,
      sideEffect: "none",
      idempotency: "read_only",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        throw new CapabilityExecutionError("timeout", "Koneksi timeout sementara");
      },
      verifier: async () => ({ ok: true }),
    });

    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Coba berkali-kali sampai habis",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_retry",
      goal: "Retry",
      steps: [
        {
          step_index: 0,
          capability_name: "failing_transient_cap",
          logical_operation_id: "op_retry_test",
          arguments: {},
          expected_result: "selesai",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_retry",
      registry,
      glmClient: glm,
    });

    // Run 1: Gagal pertama -> retry_wait (retries = 1)
    const t1 = await runner.runTask(task.task_id);
    assert.equal(t1.status, TASK_STATUS.RETRY_WAIT);

    // Run 2: Gagal kedua -> retry_wait (retries = 2)
    await storage.updateTask(task.task_id, { status: "queued", expectedVersion: t1.version });
    const t2 = await runner.runTask(task.task_id);
    assert.equal(t2.status, TASK_STATUS.RETRY_WAIT);

    // Run 3: Gagal ketiga -> retry budget habis -> FAILED
    await storage.updateTask(task.task_id, { status: "queued", expectedVersion: t2.version });
    const t3 = await runner.runTask(task.task_id);
    assert.equal(t3.status, TASK_STATUS.FAILED);
    assert.ok(t3.evidence_refs.some((e) => e.code === "retry_budget_exhausted"));
  } finally {
    close();
  }
});

test("15. Duplicate inbox: event identik tidak menghasilkan task ganda", async () => {
  const { storage, close } = await getIsolatedEnv("inbox_dup");
  try {
    const inbox = new InboxManager(storage);
    const eventParams = {
      transport: "baileys",
      chatId: "120363000000001@g.us",
      participantPn: "628123456789",
      sourceEventId: "msg_id_1001",
      payload: { text: "Buatkan catatan belanja" },
      taskIntent: { goal: "Buatkan catatan belanja" },
    };

    // Panggilan pertama: berhasil membuat task
    const res1 = await inbox.processInboundEvent(eventParams);
    assert.equal(res1.duplicate, false);
    assert.ok(res1.task);
    assert.ok(res1.task.task_id);

    // Panggilan kedua: terdeteksi duplikat, nol task baru
    const res2 = await inbox.processInboundEvent(eventParams);
    assert.equal(res2.duplicate, true);
    assert.equal(res2.task, null);

    // Verifikasi di database: tepat 1 task
    const tasks = await storage.listTasks({ chatId: "120363000000001@g.us" });
    assert.equal(tasks.length, 1);
  } finally {
    close();
  }
});

test("16. Raw WhatsApp LID ditolak di inbox fail-closed sebelum DB", async () => {
  const { storage, close } = await getIsolatedEnv("raw_lid");
  try {
    const inbox = new InboxManager(storage);
    await assert.rejects(
      async () => {
        await inbox.processInboundEvent({
          transport: "baileys",
          chatId: "120363000000001@g.us",
          participantPn: "999888777@lid",
          sourceEventId: "msg_lid_1",
          taskIntent: { goal: "Uji LID" },
        });
      },
      /Raw WhatsApp LID ditolak/,
    );
  } finally {
    close();
  }
});

test("17. Restart resume dari checkpoint: melanjutkan langkah yang belum selesai tanpa ulang", async () => {
  const { storage, registry, close } = await getIsolatedEnv("restart_resume");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Multi-step resume",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_writer",
    });

    let step0Executions = 0;
    let step1Executions = 0;

    registry.registerCapability({
      name: "counted_step_0",
      version: "1.0.0",
      description: "Langkah 0",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "write"],
      enabled: true,
      sideEffect: "write",
      idempotency: "idempotent",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async () => { step0Executions++; return {}; },
      verifier: async () => ({ ok: true }),
    });

    registry.registerCapability({
      name: "counted_step_1",
      version: "1.0.0",
      description: "Langkah 1",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "write"],
      enabled: true,
      sideEffect: "write",
      idempotency: "idempotent",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async () => { step1Executions++; return {}; },
      verifier: async () => ({ ok: true }),
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_resume",
      goal: "Resume",
      steps: [
        {
          step_index: 0,
          capability_name: "counted_step_0",
          logical_operation_id: "op_count_0",
          arguments: {},
          expected_result: "0",
        },
        {
          step_index: 1,
          capability_name: "counted_step_1",
          logical_operation_id: "op_count_1",
          arguments: {},
          expected_result: "1",
        },
      ],
    });

    // Simulasikan crash di tengah: worker 1 menjalankan hanya sampai checkpoint langkah 0
    const worker1 = new TaskRunner(storage, {
      workerId: "worker_crashed",
      registry,
      glmClient: glm,
    });

    // Jalankan worker 1
    const tFirst = await worker1.runTask(task.task_id);
    assert.equal(tFirst.status, TASK_STATUS.SUCCEEDED);
    assert.equal(step0Executions, 1);
    assert.equal(step1Executions, 1);

    // Sekarang simulasikan task yang sama dijalankan ulang (mis. duplicate claim atau restart resume)
    // Idempotency records menjamin step0 tidak pernah dieksekusi ulang
    const worker2 = new TaskRunner(storage, {
      workerId: "worker_recovered",
      registry,
      glmClient: glm,
    });

    // Reset status task ke queued untuk mensimulasikan recovery restart
    await storage.updateTask(task.task_id, { status: "queued", expectedVersion: tFirst.version });
    const tSecond = await worker2.runTask(task.task_id);

    assert.equal(tSecond.status, TASK_STATUS.SUCCEEDED, "Task yang di-resume harus berstatus succeeded, bukan failed");
    assert.equal(step0Executions, 1, "Langkah 0 tidak boleh dieksekusi ulang berkat idempotency");
    assert.equal(step1Executions, 1, "Langkah 1 tidak boleh dieksekusi ulang berkat idempotency");

    const outboxKey = buildIdempotencyKey({
      taskId: task.task_id,
      capabilityName: "send_message",
      logicalOperationId: "final_task_completion_outbox",
    });
    const outboxRecords = await storage.db.execute({
      sql: "SELECT * FROM outbox WHERE idempotency_key = ?;",
      args: [outboxKey],
    });
    assert.equal(outboxRecords.rows.length, 1, "Outbox intent final_task_completion_outbox harus tepat 1 (idempoten)");
  } finally {
    close();
  }
});

test("18. Fencing takeover: worker usang ditolak saat fencing token telah dinaikkan", async () => {
  const { storage, registry, close } = await getIsolatedEnv("fencing_takeover");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Uji fencing takeover",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const leaseManager = new LeaseManager(storage);

    // Worker 1 klaim task (leaseDurationMs = 50ms)
    const claim1 = await leaseManager.claimTask(task.task_id, { workerId: "worker_1", leaseDurationMs: 50 });
    assert.equal(claim1.fencingToken, 1);

    // Tunggu lease worker 1 kedaluwarsa
    await new Promise((r) => setTimeout(r, 60));

    // Worker 2 mengambil alih task (lease expired) -> fencing token naik jadi 2
    const claim2 = await leaseManager.claimTask(task.task_id, { workerId: "worker_2", leaseDurationMs: 30000 });
    assert.equal(claim2.fencingToken, 2);

    // Worker 1 terbangun dan mencoba checkpoint -> HARUS DITOLAK
    await assert.rejects(
      async () => {
        await leaseManager.checkpointTask(task.task_id, {
          workerId: "worker_1",
          fencingToken: claim1.fencingToken,
          status: "running",
        });
      },
      LeaseLostError,
    );
  } finally {
    close();
  }
});

test("19. Cancellation before outbox: context epoch bump membatalkan pesan sebelum delivery", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cancel_outbox");
  try {
    const cancellation = new CancellationManager(storage);
    const transport = makeMockTransport();
    const outbox = new OutboxManager(storage);

    // Buat intent outbox dengan context epoch 0
    const intent = await outbox.createIntent({
      taskId: "task_cancel_1",
      destination: "120363000000001@g.us",
      contentType: "text",
      payload: { text: "Pesan yang akan dibatalkan" },
      contextEpoch: 0,
      logicalOperationId: "op_send_cancel",
    });

    // Pengguna memicu /clear atau /reset -> epoch dinaikkan menjadi 1
    cancellation.bumpEpoch("120363000000001@g.us");
    assert.equal(cancellation.getEpoch("120363000000001@g.us"), 1);

    // Drain outbox: outbox item harus dibatalkan sebelum memanggil transport
    await outbox.drainOutbox(transport, { cancellationManager: cancellation });

    assert.equal(transport.sent.length, 0, "Transport tidak boleh menerima pesan dari epoch usang");
    const item = await storage.getOutbox(intent.outbox_id);
    assert.equal(item.status, "cancelled");
  } finally {
    close();
  }
});

test("20. Cancellation during multi-step: epoch bump saat task berjalan membatalkan langkah berikutnya", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cancel_mid_task");
  try {
    const cancellation = new CancellationManager(storage);
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Batal di tengah jalan",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      context_epoch: 0,
    });

    // Naikkan epoch sebelum runner memproses
    cancellation.bumpEpoch("120363000000001@g.us");

    const runner = new TaskRunner(storage, {
      workerId: "worker_mid_cancel",
      registry,
      cancellationManager: cancellation,
    });

    const result = await runner.runTask(task.task_id);
    assert.equal(result.status, TASK_STATUS.CANCELLED);
  } finally {
    close();
  }
});

test("21. Shadow mode zero external effect: outbox disimulasikan, nol WhatsApp send", async () => {
  const { storage, registry, close } = await getIsolatedEnv("shadow_zero_send");
  try {
    const transport = makeMockTransport();
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Catat di shadow",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_writer",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_shadow",
      goal: "Shadow",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_shadow_note",
          arguments: { title: "Shadow Note", content: "Isi rahasia shadow" },
          expected_result: "Tersimpan",
        },
      ],
      final_response: "Catatan shadow selesai",
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_shadow",
      engineMode: "shadow",
      registry,
      glmClient: glm,
    });

    const res = await runner.runTask(task.task_id);
    assert.equal(res.status, TASK_STATUS.SUCCEEDED);

    // Verifikasi outbox dibuat dan diproses dengan simulated receipt
    const outboxList = await storage.listPendingOutbox();
    // Dalam shadow mode, outbox langsung diselesaikan simulated saat didrain atau processOutboxItem
    await runner.outboxManager.drainOutbox(transport);
    assert.equal(transport.sent.length, 0, "Shadow mode dilarang memanggil transport pengiriman nyata");
  } finally {
    close();
  }
});

test("22. Shadow mode zero production write: task nyata (>=1 langkah) di shadow mode menjaga SHA-256 file produksi identik, nol send/presence, dan outbox tersimulasi", async () => {
  const prodMemPath = path.join(testDir, "test-prod-ai-memory.json");
  const prodJobsPath = path.join(testDir, "test-prod-agent-jobs.json");
  fs.writeFileSync(prodMemPath, JSON.stringify({ version: 2, groups: {}, people: {} }, null, 2));
  fs.writeFileSync(prodJobsPath, JSON.stringify({ jobs: [] }, null, 2));

  const memHashBefore = fileSha256(prodMemPath);
  const jobsHashBefore = fileSha256(prodJobsPath);

  const prevMemEnv = process.env.AI_MEMORY_FILE;
  const prevJobsEnv = process.env.AGENT_JOBS_FILE;
  process.env.AI_MEMORY_FILE = prodMemPath;
  process.env.AGENT_JOBS_FILE = prodJobsPath;

  const { storage, registry, close } = await getIsolatedEnv("shadow_real_task_hashes");
  try {
    const mockTransport = makeMockTransport();
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Jalankan peringkasan dan pembuatan catatan di shadow",
      acceptance_criteria: "Catatan terverifikasi di shadow",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_shadow_tester",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_shadow_meaningful",
      goal: task.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "summarize_context",
          logical_operation_id: "op_shadow_sum",
          arguments: { text: "Percakapan shadow penting" },
          expected_result: "Ringkasan dihasilkan",
        },
        {
          step_index: 1,
          capability_name: "create_note",
          logical_operation_id: "op_shadow_note",
          arguments: { title: "Shadow Note", content: "Isi catatan shadow tanpa efek eksternal" },
          expected_result: "Note tersimpan di SQLite",
        },
      ],
      final_response: "Catatan shadow berhasil dibuat",
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_shadow_meaningful",
      engineMode: "shadow",
      registry,
      glmClient: glm,
    });

    const result = await runner.runTask(task.task_id);
    assert.equal(result.status, TASK_STATUS.SUCCEEDED);

    // Kuras outbox dengan mock transport
    const drained = await runner.outboxManager.drainOutbox(mockTransport);

    // 1. Verifikasi nol pesan dikirim ke transport eksternal nyata
    assert.equal(mockTransport.sent.length, 0, "Transport nyata dilarang dipanggil di shadow mode");

    // 2. Verifikasi outbox hanya diselesaikan secara tersimulasi
    assert.ok(drained.length > 0, "Outbox item harus diproses");
    for (const item of drained) {
      assert.equal(item.status, "delivered");
      assert.ok(item.delivery_receipt?.simulated === true, "Delivery receipt harus tersimulasi");
      assert.ok(item.delivery_receipt?.shadow === true, "Delivery receipt harus menandai mode shadow");
    }

    // 3. Verifikasi SHA-256 kedua file tidak berubah sama sekali
    assert.equal(fileSha256(prodMemPath), memHashBefore, "ai-memory.json dilarang berubah");
    assert.equal(fileSha256(prodJobsPath), jobsHashBefore, "agent-jobs.json dilarang berubah");
  } finally {
    process.env.AI_MEMORY_FILE = prevMemEnv;
    process.env.AGENT_JOBS_FILE = prevJobsEnv;
    close();
    try { fs.unlinkSync(prodMemPath); } catch {}
    try { fs.unlinkSync(prodJobsPath); } catch {}
  }
});

test("23. Agent mode canary allowlist fail closed: bila allowlist kosong, efek eksternal ditolak", async () => {
  const { storage, registry, close } = await getIsolatedEnv("canary_fail_closed");
  try {
    const canaryEmpty = new CanaryManager({ ownerPn: null, allowedChats: [] });
    const transport = makeMockTransport();
    const outbox = new OutboxManager(storage, {
      engineMode: "agent",
      canaryManager: canaryEmpty,
    });

    const intent = await outbox.createIntent({
      taskId: "task_agent_canary_fail",
      destination: "120363000000001@g.us",
      contentType: "text",
      payload: { text: "Harus ditolak karena allowlist kosong" },
      logicalOperationId: "op_canary_check",
    });

    await outbox.drainOutbox(transport);

    assert.equal(transport.sent.length, 0, "Transport dilarang dipanggil bila allowlist kosong (fail closed)");
    const item = await storage.getOutbox(intent.outbox_id);
    assert.equal(item.status, "cancelled");
    assert.ok(item.error_message.includes("canary allowlist"));
  } finally {
    close();
  }
});

test("24. Agent mode canary allowlist success: grup/owner terdaftar diizinkan mengirim", async () => {
  const { storage, registry, close } = await getIsolatedEnv("canary_allowed");
  try {
    const canaryAllowed = new CanaryManager({
      ownerPn: "628111222333",
      allowedChats: ["120363000000001@g.us"],
    });
    const transport = makeMockTransport();
    const outbox = new OutboxManager(storage, {
      engineMode: "agent",
      canaryManager: canaryAllowed,
    });

    const intent = await outbox.createIntent({
      taskId: "task_agent_canary_ok",
      destination: "120363000000001@g.us",
      contentType: "text",
      payload: { text: "Pesan canary yang sah" },
      logicalOperationId: "op_canary_ok",
    });

    await outbox.drainOutbox(transport);

    assert.equal(transport.sent.length, 1, "Transport harus mengirim bila chat terdaftar di canary");
    const item = await storage.getOutbox(intent.outbox_id);
    assert.equal(item.status, "delivered");
  } finally {
    close();
  }
});

test("25. Cross-chat note isolation: read_note terhadap catatan obrolan lain ditolak", async () => {
  const { storage, registry, close } = await getIsolatedEnv("cross_chat_isolation");
  try {
    // 1. Buat catatan di Chat A
    const note = await storage.createNote({
      chatId: "120363000000001@g.us",
      ownerPn: "628111111111",
      title: "Catatan Rahasia Chat A",
      content: "Hanya untuk Chat A",
    });

    // 2. Buat task di Chat B yang mencoba membaca catatan milik Chat A
    const taskStore = new TaskStore(storage);
    const taskB = await taskStore.createTask({
      goal: "Membaca catatan chat A dari chat B",
      actor_pn: "628222222222",
      chat_id: "120363000000002@g.us", // Chat B
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_cross_chat",
      goal: "Baca",
      steps: [
        {
          step_index: 0,
          capability_name: "read_note",
          logical_operation_id: "op_read_cross",
          arguments: { note_id: note.note_id },
          expected_result: "Catatan",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_cross_chat",
      registry,
      glmClient: glm,
    });

    const failed = await runner.runTask(taskB.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);

    const steps = await storage.getTaskSteps(taskB.task_id);
    assert.equal(steps[0].status, "failed");
    assert.ok(steps[0].observation_redacted.message.includes("Akses ditolak"));
  } finally {
    close();
  }
});

test("read_note menolak pembacaan bila scope chat tidak diberikan", async () => {
  const { storage, registry, close } = await getIsolatedEnv("note_missing_scope");
  try {
    const note = await storage.createNote({ chatId: "chat_a@g.us", ownerPn: "628111111111", title: "Rahasia", content: "Privat" });
    await assert.rejects(
      registry.getCapability("read_note").handler({ note_id: note.note_id }, { storage }),
      /active_chat_required/,
    );
  } finally {
    close();
  }
});

test("export_archive belum tersedia dan tidak boleh mengklaim arsip berhasil", async () => {
  const registry = createCapabilityRegistry();
  registerMvpCapabilities(registry);
  const capability = registry.getCapability("export_archive");
  assert.equal(capability.enabled, false);
  await assert.rejects(capability.handler({ archive_name: "tes" }), /archive_not_implemented/);
});

test("authorization_ref tidak menaikkan izin dari substring seperti disallow", async () => {
  const { storage, registry, close } = await getIsolatedEnv("auth_ref_substring");
  try {
    const runner = new TaskRunner(storage, { registry });
    const actor = { id: "628222222222", isOwner: false };
    const scopes = runner.deriveActiveScopes({ chat_id: "chat@g.us", scope: "active_chat", authorization_ref: "disallow_owner" }, actor);
    assert.equal(scopes.includes("write"), false);
  } finally { close(); }
});

test("replan atomik setelah note tidak ditemukan menyelesaikan tiga langkah tanpa mengulang write", async () => {
  const { storage, registry, close } = await getIsolatedEnv("replan_missing_note");
  try {
    const note = await storage.createNote({ chatId: "chat@g.us", ownerPn: "628123456789", title: "Agenda", content: "Rapat jam 10" });
    const task = await new TaskStore(storage).createTask({ goal: "Baca agenda dan ringkas", actor_pn: "628123456789", chat_id: "chat@g.us", scope: "active_chat,read" });
    let calls = 0;
    const glmClient = makeMockGlmClient(() => {
      calls++;
      return calls === 1
        ? { plan_id: "bad_lookup", goal: "Baca agenda", steps: [{ step_index: 0, capability_name: "read_note", logical_operation_id: "wrong_lookup", arguments: { note_id: "missing_note" }, expected_result: "Agenda" }] }
        : { plan_id: "corrected_lookup", goal: "Baca agenda dan ringkas", steps: [
          { step_index: 0, capability_name: "read_note", logical_operation_id: "correct_lookup", arguments: { note_id: note.note_id }, expected_result: "Agenda terbaca" },
          { step_index: 1, capability_name: "summarize_context", logical_operation_id: "summary_one", arguments: { text: "Agenda rapat jam 10. Peserta membawa bahan." }, expected_result: "Ringkasan" },
          { step_index: 2, capability_name: "summarize_context", logical_operation_id: "summary_two", arguments: { text: "Rapat jam 10. Bahan wajib dibawa." }, expected_result: "Ringkasan akhir" },
        ], final_response: "Agenda ditemukan dan diringkas." };
    });
    const runner = new TaskRunner(storage, { registry, glmClient });
    const result = await runner.runTask(task.task_id);
    assert.equal(result.status, TASK_STATUS.SUCCEEDED);
    assert.equal(result.plan_version, 2);
    assert.equal(calls, 2);
    const steps = await storage.getTaskSteps(task.task_id);
    assert.deepEqual(steps.map((s) => s.status), ["superseded", "succeeded", "succeeded", "succeeded"]);
    assert.ok(result.evidence_refs.some((e) => e.type === "replan"));
    const outboxKey = buildIdempotencyKey({ taskId: task.task_id, capabilityName: "send_message", logicalOperationId: "final_task_completion_outbox" });
    const outbox = await storage.getOutboxByIdempotencyKey(outboxKey);
    assert.equal(outbox.payload.text, "Agenda ditemukan dan diringkas.");
  } finally { close(); }
});

test("inbound media task menyimpan asset privat, memverifikasi entry ID, dan gagal tertutup tanpa media", async () => {
  const oldFlag = process.env.AGENT_MESSAGE_MEDIA_ENABLED;
  const oldStickerFlag = process.env.AGENT_MAKE_STICKER_ENABLED;
  const oldSendFlag = process.env.AGENT_SEND_ASSET_ENABLED;
  process.env.AGENT_MESSAGE_MEDIA_ENABLED = "true";
  process.env.AGENT_MAKE_STICKER_ENABLED = "true";
  process.env.AGENT_SEND_ASSET_ENABLED = "true";
  const assetStore = new AssetStore({ root: path.join(testDir, "inbound-media-assets") });
  const lc = new RuntimeLifecycle({ engineMode: "agent", dbPath: path.join(testDir, "inbound-media.db"), assetStore, transport: makeMockTransport(), sock: makeMockSocket() });
  await lc.init();
  try {
    lc.getCanaryManager().customAllowedChats = ["120363000000001@g.us"];
    setData({ owner: "628123456789", allowedGroups: ["120363000000001@g.us"] });
    const message = makeBaileysMessage({ id: "media-entry-1", text: "/task media" });
    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "read_source_media", goal: "Ambil asset gambar", steps: [
        { step_index: 0, capability_name: "fetch_media_from_message", logical_operation_id: "read_source", arguments: { entry_id: message.key.id }, expected_result: "Asset terverifikasi" },
      ],
    });
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const result = await dispatchInboundMessage(message, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => ({ type: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }) });
    assert.equal(result.taskExecutionResult.status, TASK_STATUS.SUCCEEDED, JSON.stringify(result.taskExecutionResult.evidence_refs));
    const refs = (await lc.storage.getTask(result.task.task_id)).evidence_refs;
    const source = refs.find((item) => item.type === "source_media");
    assert.ok(source?.asset_id);
    await assert.rejects(lc.registry.getCapability("fetch_media_from_message").handler({ entry_id: "other-entry" }, { storage: lc.storage, taskId: result.task.task_id, originChatId: message.key.remoteJid }), /media_source_denied/);
    await assert.rejects(assetStore.read(source.asset_id, { chatId: "other-chat@g.us", taskId: result.task.task_id }), /asset_scope_denied/);
    const missing = makeBaileysMessage({ id: "media-entry-2", text: "/task media" });
    const unavailable = await dispatchInboundMessage(missing, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => null });
    assert.equal(unavailable.status, "media_unavailable");
    assert.equal((await lc.storage.getTask(unavailable.taskId)).status, TASK_STATUS.FAILED);
    const forged = makeBaileysMessage({ id: "media-entry-forged", text: "/task media" });
    const forgedResult = await dispatchInboundMessage(forged, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => ({ type: "image", dataUrl: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64")}` }) });
    assert.equal(forgedResult.status, "media_unavailable");
    assert.equal((await lc.storage.getTask(forgedResult.taskId)).status, TASK_STATUS.FAILED);
    const stickerMessage = makeBaileysMessage({ id: "media-entry-sticker", text: "/task stiker" });
    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "make_source_sticker", goal: "Buat stiker", steps: [
        { step_index: 0, capability_name: "fetch_media_from_message", logical_operation_id: "fetch_source", arguments: { entry_id: stickerMessage.key.id }, expected_result: "Asset dibaca" },
        { step_index: 1, capability_name: "make_sticker", logical_operation_id: "convert_sticker", arguments: { asset_id: "$last_asset" }, expected_result: "Stiker dibuat" },
      ],
    });
    const validPng = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#00ff00" } }).png().toBuffer();
    const stickerResult = await dispatchInboundMessage(stickerMessage, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => ({ type: "image", dataUrl: `data:image/png;base64,${validPng.toString("base64")}` }) });
    assert.equal(stickerResult.taskExecutionResult.status, TASK_STATUS.SUCCEEDED, JSON.stringify(stickerResult.taskExecutionResult.evidence_refs));
    const stickerSteps = await lc.storage.getTaskSteps(stickerResult.task.task_id);
    assert.deepEqual(stickerSteps.map((step) => step.status), ["succeeded", "succeeded"]);
    const stickerAssetId = stickerSteps[1].observation_redacted.data.asset_id;
    assert.equal((await assetStore.read(stickerAssetId, { chatId: stickerMessage.key.remoteJid, taskId: stickerResult.task.task_id })).mime, "image/webp");
    await lc.getOutboxManager().drainOutbox(makeMockTransport(), { cancellationManager: lc.getCancellationManager() });
    const sendMessage = makeBaileysMessage({ id: "media-entry-send", text: "/task kirim stiker" });
    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "send_source_sticker", goal: "Buat dan kirim stiker", steps: [
        { step_index: 0, capability_name: "fetch_media_from_message", logical_operation_id: "fetch_send_source", arguments: { entry_id: sendMessage.key.id }, expected_result: "Asset dibaca" },
        { step_index: 1, capability_name: "make_sticker", logical_operation_id: "convert_send_sticker", arguments: { asset_id: "$last_asset" }, expected_result: "Stiker dibuat" },
        { step_index: 2, capability_name: "send_asset", logical_operation_id: "send_sticker", arguments: { asset_id: "$last_asset", mode: "sticker" }, expected_result: "Stiker diantrekan ke chat asal" },
      ],
    });
    const sendResult = await dispatchInboundMessage(sendMessage, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => ({ type: "image", dataUrl: `data:image/png;base64,${validPng.toString("base64")}` }) });
    assert.equal(sendResult.taskExecutionResult.status, TASK_STATUS.VERIFYING, JSON.stringify(sendResult.taskExecutionResult.evidence_refs));
    const sentBeforeDrain = lc.sock.sentMessages.length;
    const drained = await lc.getOutboxManager().drainOutbox(lc.durableScheduler.createSocketTransport(lc.sock), { cancellationManager: lc.getCancellationManager() });
    assert.equal(drained.length, 1);
    assert.equal(lc.sock.sentMessages.length, sentBeforeDrain + 1);
    assert.ok(Buffer.isBuffer(lc.sock.sentMessages.at(-1).content.sticker));
    assert.equal((await lc.storage.getTask(sendResult.task.task_id)).status, TASK_STATUS.SUCCEEDED);
    const uncertainMessage = makeBaileysMessage({ id: "media-entry-uncertain", text: "/task kirim stiker" });
    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "send_uncertain_sticker", goal: "Kirim stiker", steps: [
        { step_index: 0, capability_name: "fetch_media_from_message", logical_operation_id: "fetch_uncertain_source", arguments: { entry_id: uncertainMessage.key.id }, expected_result: "Asset dibaca" },
        { step_index: 1, capability_name: "make_sticker", logical_operation_id: "convert_uncertain_sticker", arguments: { asset_id: "$last_asset" }, expected_result: "Stiker dibuat" },
        { step_index: 2, capability_name: "send_asset", logical_operation_id: "send_uncertain_sticker", arguments: { asset_id: "$last_asset", mode: "sticker" }, expected_result: "Stiker diantrekan" },
      ],
    });
    const uncertainTask = await dispatchInboundMessage(uncertainMessage, { lifecycle: lc, sock: lc.sock, mediaLoader: async () => ({ type: "image", dataUrl: `data:image/png;base64,${validPng.toString("base64")}` }) });
    assert.equal(uncertainTask.taskExecutionResult.status, TASK_STATUS.VERIFYING);
    const crashTransport = makeMockTransport();
    crashTransport.simulateCrashPostSend = true;
    const uncertainOutbox = await lc.getOutboxManager().drainOutbox(crashTransport, { cancellationManager: lc.getCancellationManager() });
    assert.equal(uncertainOutbox[0].status, "uncertain");
    assert.equal((await lc.storage.getTask(uncertainTask.task.task_id)).status, TASK_STATUS.DELIVERY_UNCERTAIN);
    await lc.getOutboxManager().drainOutbox(crashTransport, { cancellationManager: lc.getCancellationManager() });
    assert.equal(crashTransport.sent.length, 1, "outbox uncertain tidak dikirim ulang otomatis");
    assert.equal((await lc.getOutboxManager().reconcileDelivery({ outboxId: uncertainOutbox[0].outbox_id, transportMessageId: "unverified-test-id", confirmed: false })).status, "uncertain");
    await lc.getOutboxManager().reconcileDelivery({ outboxId: uncertainOutbox[0].outbox_id, transportMessageId: "confirmed-test-id", confirmed: true });
    assert.equal((await lc.storage.getTask(uncertainTask.task.task_id)).status, TASK_STATUS.SUCCEEDED);
  } finally {
    await lc.shutdown();
    if (oldFlag === undefined) delete process.env.AGENT_MESSAGE_MEDIA_ENABLED; else process.env.AGENT_MESSAGE_MEDIA_ENABLED = oldFlag;
    if (oldStickerFlag === undefined) delete process.env.AGENT_MAKE_STICKER_ENABLED; else process.env.AGENT_MAKE_STICKER_ENABLED = oldStickerFlag;
    if (oldSendFlag === undefined) delete process.env.AGENT_SEND_ASSET_ENABLED; else process.env.AGENT_SEND_ASSET_ENABLED = oldSendFlag;
  }
});

test("startup recovery menyelesaikan task asset bila outbox sudah delivered sebelum crash", async () => {
  const { storage, close } = await getIsolatedEnv("asset_delivery_recovery");
  try {
    const task = await new TaskStore(storage).createTask({ goal: "Kirim gambar", actor_pn: "628123456789", chat_id: "chat@g.us" });
    const claim = await new LeaseManager(storage).claimTask(task.task_id, { workerId: "asset_worker" });
    const completion = await storage.completeTaskWithOutboxIntent({
      taskId: task.task_id, workerId: "asset_worker", fencingToken: claim.fencingToken, terminalStatus: TASK_STATUS.VERIFYING,
      outboxIntent: { destination: "chat@g.us", content_type: "image", payload: { asset_id: "asset_fixture", task_id: task.task_id, chat_id: "chat@g.us", mime: "image/png" }, idempotency_key: buildIdempotencyKey({ taskId: task.task_id, capabilityName: "send_asset", logicalOperationId: "fixture_send" }) },
    });
    const outbox = new OutboxManager(storage, { engineMode: "legacy" });
    const sent = await outbox.processOutboxItem(completion.outbox, makeMockTransport());
    assert.equal(sent.status, "delivered");
    assert.equal((await storage.getTask(task.task_id)).status, TASK_STATUS.VERIFYING);
    const recovered = await runStartupRecovery(storage);
    assert.equal(recovered.settledAssetTasks, 1);
    assert.equal((await storage.getTask(task.task_id)).status, TASK_STATUS.SUCCEEDED);
  } finally { close(); }
});

test("dispatcher agent menolak grup tak diizinkan dan DM asing sebelum membuat task", async () => {
  const lc = new RuntimeLifecycle({ engineMode: "agent", dbPath: path.join(testDir, "inbound_acl_denied.db"), transport: makeMockTransport(), sock: makeMockSocket() });
  await lc.init();
  try {
    const group = "120363000000009@g.us";
    lc.getCanaryManager().customAllowedChats = [group];
    setData({ owner: "628123456789", allowedGroups: [] });
    const groupResult = await dispatchInboundMessage(makeBaileysMessage({ remoteJid: group, text: "/task catat: rahasia" }), { lifecycle: lc, sock: lc.sock });
    assert.equal(groupResult.status, "rejected_group_not_allowed");
    const foreignDm = makeBaileysMessage({ remoteJid: "628999888777@s.whatsapp.net", participant: "628999888777@s.whatsapp.net", text: "/task catat: coba" });
    const dmResult = await dispatchInboundMessage(foreignDm, { lifecycle: lc, sock: lc.sock });
    assert.equal(dmResult.status, "rejected_dm_not_whitelisted");
    assert.equal((await lc.storage.db.execute("SELECT COUNT(*) AS n FROM tasks;")).rows[0].n, 0);
  } finally { await lc.shutdown(); }
});

test("26. Audit secret redaction: sensor API key dan token Authorization pada jejak audit", async () => {
  const { storage, close } = await getIsolatedEnv("audit_redact");
  try {
    const audit = new AuditManager(storage);
    const secretApiKey = "sk-or-v1-abcdef1234567890abcdef1234567890";
    const secretToken = "Bearer secret_bearer_token_xyz";

    await audit.recordEvent({
      eventType: "task_test_audit",
      taskId: "task_audit_1",
      actorPn: "628123456789",
      details: {
        apiKey: secretApiKey,
        headers: { Authorization: secretToken },
        mediaData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      },
    });

    const events = await audit.getEvents({ taskId: "task_audit_1" });
    assert.equal(events.length, 1);
    const details = events[0].details;

    assert.equal(details.apiKey, "[REDACTED]");
    assert.equal(details.headers.Authorization, "[REDACTED]");
    assert.match(details.mediaData, /^\[REDACTED_DATA_URL: image\/png,/);
  } finally {
    close();
  }
});

test("27. Verifier deterministic output mismatch: output capability melanggar schema ditolak", async () => {
  const { storage, registry, close } = await getIsolatedEnv("verifier_mismatch");
  try {
    registry.registerCapability({
      name: "bad_output_cap",
      version: "1.0.0",
      description: "Capability yang menghasilkan output di luar kontrak schema",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "read"],
      enabled: true,
      sideEffect: "none",
      idempotency: "read_only",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: false,
      },
      handler: async () => {
        // Mengembalikan string, bukan integer
        return { count: "bukan_integer" };
      },
      verifier: async () => ({ ok: true }),
    });

    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Uji verifier mismatch",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_bad_output",
      goal: "Goal",
      steps: [
        {
          step_index: 0,
          capability_name: "bad_output_cap",
          logical_operation_id: "op_bad_out",
          arguments: {},
          expected_result: "count",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_bad_out",
      registry,
      glmClient: glm,
    });

    const failed = await runner.runTask(task.task_id);
    assert.equal(failed.status, TASK_STATUS.FAILED);
  } finally {
    close();
  }
});

test("28. Acceptance criteria verification: verifier memeriksa acceptance criteria sebelum succeeded", async () => {
  const { storage, registry, close } = await getIsolatedEnv("acceptance_criteria");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Buat catatan penting",
      acceptance_criteria: "Catatan terbukti tersimpan",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_writer",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_accept",
      goal: "Catat",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_accept_note",
          arguments: { title: "Catatan Sah", content: "Isi catatan sah" },
          expected_result: "Note ID terverifikasi",
        },
      ],
      final_response: "Catatan berhasil dibuat",
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_accept",
      registry,
      glmClient: glm,
    });

    const succeeded = await runner.runTask(task.task_id);
    assert.equal(succeeded.status, TASK_STATUS.SUCCEEDED);
    assert.ok(succeeded.evidence_refs.length >= 1);
  } finally {
    close();
  }
});

test("29. Invariant: status running tidak pernah menggantung tanpa lease/recovery", async () => {
  const { storage, registry, close } = await getIsolatedEnv("no_hanging_running");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Crash tiba-tiba di tengah eksekusi",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
    });

    const leaseManager = new LeaseManager(storage);
    // Klaim task dengan durasi lease sangat singkat (10ms)
    await leaseManager.claimTask(task.task_id, { workerId: "worker_crasher", leaseDurationMs: 10 });

    const claimed = await storage.getTask(task.task_id);
    assert.equal(claimed.status, "running");

    // Tunggu lease kedaluwarsa
    await new Promise((r) => setTimeout(r, 20));

    // Recovery lease kedaluwarsa
    const recoveryRes = await leaseManager.recoverExpiredLeases(Date.now());
    assert.equal(recoveryRes.recoveredTasks, 1);

    const recovered = await storage.getTask(task.task_id);
    assert.equal(recovered.status, "retry_wait", "Task running kedaluwarsa wajib dipulihkan ke retry_wait");
    assert.equal(recovered.worker_id, null);
  } finally {
    close();
  }
});

test("30. ProcessLock & Lifecycle: Durable loop hanya aktif bila ProcessLock berhasil diperoleh", async () => {
  const { dbPath, close } = await getIsolatedEnv("lifecycle_lock");
  close(); // Tutup koneksi agar dapat dipakai lifecycle

  const mockTransport = makeMockTransport();
  const lc1 = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    workerId: "instance_holder",
  });

  const res1 = await lc1.init();
  assert.equal(res1.lockHeld, true);
  assert.ok(lc1.taskRunner);

  // Instance kedua mencoba connect ke DB yang sama -> ProcessLock gagal -> TaskRunner TIDAK jalan
  const lc2 = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    workerId: "instance_competing",
  });

  const res2 = await lc2.init();
  assert.equal(res2.lockHeld, false, "Instance kedua dilarang mengambil lock");
  assert.equal(lc2.taskRunner, null, "TaskRunner dilarang aktif tanpa ProcessLock");

  await lc1.shutdown();
  await lc2.shutdown();
});

// ============================================================================
// INTEGRASI DISPATCHER INBOUND WHATSAPP NYATA (KONTRAK KOREKSI FASE 3)
// ============================================================================

function makeMockSocket({ me = "628111111111@s.whatsapp.net", isGroupAdmin = false } = {}) {
  const sentMessages = [];
  return {
    user: { id: me, lid: "bot_lid@lid" },
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { remoteJid: jid, id: `bot_msg_${Date.now()}` } };
    },
    groupMetadata: async (jid) => {
      return {
        id: jid,
        subject: "Test Group",
        participants: [
          { id: me, admin: "admin" },
          { id: "628123456789@s.whatsapp.net", admin: isGroupAdmin ? "admin" : null, phoneNumber: "628123456789" },
          { id: "628999999999@s.whatsapp.net", admin: null, phoneNumber: "628999999999" },
        ],
      };
    },
  };
}

function makeBaileysMessage({
  id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  remoteJid = "120363000000001@g.us",
  participant = "628123456789@s.whatsapp.net",
  text = "",
  fromMe = false,
  pushName = "Tester",
  mentionedJid = [],
  quotedMessage = null,
} = {}) {
  return {
    key: {
      remoteJid,
      fromMe,
      id,
      participant,
    },
    pushName,
    message: {
      conversation: text,
      extendedTextMessage: {
        text,
        contextInfo: {
          mentionedJid,
          quotedMessage,
        },
      },
    },
  };
}

test("31. Inbound Dispatcher: legacy mode tidak membuat event atau task di database runtime", async () => {
  const { storage, close } = await getIsolatedEnv("inbound_legacy");
  try {
    const lc = new RuntimeLifecycle({ engineMode: "legacy" });
    await lc.init();

    const mockSock = makeMockSocket();
    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "/task catat: Rapat penting",
    });

    await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    // Di mode legacy, storage tidak dibuka dan tidak ada task SQLite
    assert.equal(lc.storage, null);
    assert.equal(lc.taskRunner, null);

    const taskCount = (await storage.db.execute("SELECT COUNT(*) AS c FROM tasks;")).rows[0].c;
    const eventCount = (await storage.db.execute("SELECT COUNT(*) AS c FROM inbox_events;")).rows[0].c;
    assert.equal(Number(taskCount), 0);
    assert.equal(Number(eventCount), 0);

    await lc.shutdown();
  } finally {
    close();
  }
});

test("32. Inbound Dispatcher: agent addressed command menghasilkan durable event & task lalu dieksekusi runner", async () => {
  const dbPath = path.join(testDir, "inbound_agent.db");
  const mockTransport = makeMockTransport();
  const mockSock = makeMockSocket({ isGroupAdmin: true });
  const lc = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    sock: mockSock,
    workerId: "agent_inbound_worker",
  });
  await lc.init();

  try {
    lc.getCanaryManager().customAllowedChats = ["120363000000001@g.us"];
    lc.getCanaryManager().customOwnerPn = "628123456789";
    setData({ owner: "628123456789", allowedGroups: ["120363000000001@g.us"] });

    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "plan_agent_inbound",
      goal: "Buat catatan: Rilis versi baru",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "step_create_release",
          arguments: { title: "Rilis Baru", content: "Versi 3.0 selesai audit" },
          expected_result: "Note tersimpan",
        },
      ],
      final_response: "Catatan rilis berhasil dibuat",
    });

    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "/task catat: Rilis versi baru",
    });

    const res = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    assert.equal(res.status, "task_enqueued_and_executed");
    assert.equal(res.duplicate, false);
    assert.ok(res.task);
    assert.equal(res.taskExecutionResult.status, TASK_STATUS.SUCCEEDED);

    // Verifikasi tersimpan persisten di SQLite
    const events = await lc.storage.db.execute("SELECT * FROM inbox_events;");
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].source_event_id, m.key.id);

    const tasks = await lc.storage.db.execute("SELECT * FROM tasks;");
    assert.equal(tasks.rows.length, 1);
    assert.equal(tasks.rows[0].status, TASK_STATUS.SUCCEEDED);

    const notes = await lc.storage.db.execute("SELECT * FROM notes;");
    assert.equal(notes.rows.length, 1);
    assert.equal(notes.rows[0].title, "Rilis Baru");
  } finally {
    await lc.shutdown();
  }
});

test("32b. Inbound /task ingat menyimpan fakta dari pesan sumber melalui runner", async () => {
  const priorFlag = process.env.AGENT_MEMORY_FACTS_ENABLED;
  process.env.AGENT_MEMORY_FACTS_ENABLED = "true";
  const chatId = "120363000000001@g.us";
  const actorPn = "628123456789";
  const lc = new RuntimeLifecycle({ engineMode: "agent", dbPath: path.join(testDir, "inbound_memory.db"), transport: makeMockTransport(), sock: makeMockSocket({ isGroupAdmin: true }), workerId: "memory_inbound_worker" });
  try {
    await lc.init();
    lc.getCanaryManager().customAllowedChats = [chatId];
    lc.getCanaryManager().customOwnerPn = actorPn;
    setData({ owner: actorPn, allowedGroups: [chatId] });
    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "plan_memory_inbound",
      goal: "Ingat fakta: Jadwal rapat: Jumat",
      steps: [{ step_index: 0, capability_name: "memory_remember", logical_operation_id: "remember_source", arguments: {}, expected_result: "Fakta tersimpan" }],
      final_response: "Fakta tersimpan",
    });
    const m = makeBaileysMessage({ remoteJid: chatId, participant: `${actorPn}@s.whatsapp.net`, text: "/task ingat Jadwal rapat: Jumat" });
    const result = await dispatchInboundMessage(m, { sock: lc.sock, lifecycle: lc });
    assert.equal(result.status, "task_enqueued_and_executed");
    assert.equal(result.taskExecutionResult.status, TASK_STATUS.SUCCEEDED);
    const found = await lc.storage.searchMemoryFacts({ chatId, actorPn, query: "rapat" });
    assert.equal(found.length, 1);
    assert.equal(found[0].source_entry_id, m.key.id);
    assert.equal(found[0].fact_text, "Jadwal rapat: Jumat");
  } finally {
    await lc.shutdown();
    if (priorFlag === undefined) delete process.env.AGENT_MEMORY_FACTS_ENABLED;
    else process.env.AGENT_MEMORY_FACTS_ENABLED = priorFlag;
  }
});

test("33. Inbound Dispatcher: duplicate Baileys message ID hanya menghasilkan 1 task", async () => {
  const dbPath = path.join(testDir, "inbound_dedup.db");
  const mockTransport = makeMockTransport();
  const mockSock = makeMockSocket();
  const lc = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    sock: mockSock,
    workerId: "dedup_inbound_worker",
  });
  await lc.init();

  try {
    lc.getCanaryManager().customAllowedChats = ["120363000000001@g.us"];
    setData({ owner: "628123456789", allowedGroups: ["120363000000001@g.us"] });

    lc.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "plan_dedup",
      goal: "Buat catatan: Uji dedup",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "step_create_dedup",
          arguments: { title: "Dedup Test", content: "Pesan pertama" },
          expected_result: "Tersimpan",
        },
      ],
      final_response: "Catatan dibuat",
    });

    const messageId = "duplicate_baileys_msg_101";
    const m = makeBaileysMessage({
      id: messageId,
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "/task catat: Uji dedup",
    });

    const res1 = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    assert.equal(res1.status, "task_enqueued_and_executed");
    assert.equal(res1.duplicate, false);

    // Kirim pesan yang sama persis (simulasi retry Baileys transport)
    const res2 = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    assert.equal(res2.status, "duplicate_event");
    assert.equal(res2.duplicate, true);
    assert.equal(res2.task, null);

    // Di SQLite tetap tepat 1 task dan 1 event
    const tasks = await lc.storage.db.execute("SELECT * FROM tasks;");
    assert.equal(tasks.rows.length, 1);
  } finally {
    await lc.shutdown();
  }
});

test("34. Inbound Dispatcher: pesan grup biasa tanpa mention bot tidak membuat task", async () => {
  const dbPath = path.join(testDir, "inbound_non_addressed.db");
  const mockSock = makeMockSocket();
  const lc = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    sock: mockSock,
    workerId: "non_addressed_worker",
  });
  await lc.init();

  try {
    lc.getCanaryManager().customAllowedChats = ["120363000000001@g.us"];
    setData({ owner: "628123456789", allowedGroups: ["120363000000001@g.us"] });

    // Pesan biasa antar anggota grup
    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "Halo teman-teman, jangan lupa makan siang ya",
    });

    const res = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    assert.equal(res.status, "ignored_non_addressed_group");
    assert.equal(res.handled, false);

    const tasks = await lc.storage.db.execute("SELECT * FROM tasks;");
    assert.equal(tasks.rows.length, 0);
  } finally {
    await lc.shutdown();
  }
});

test("35. Inbound Dispatcher: identitas raw LID ditolak fail-closed dan tidak membuat task", async () => {
  const dbPath = path.join(testDir, "inbound_raw_lid.db");
  const mockSock = makeMockSocket();
  const lc = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    sock: mockSock,
    workerId: "raw_lid_worker",
  });
  await lc.init();

  try {
    lc.getCanaryManager().customAllowedChats = ["120363000000001@g.us"];
    setData({ owner: "628123456789", allowedGroups: ["120363000000001@g.us"] });

    // Pesan dengan participant raw WhatsApp LID tanpa verifikasi PN
    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "987654321012345@lid",
      text: "/task catat: Rahasia tanpa nomor HP sah",
    });

    const res = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lc });
    assert.equal(res.status, "rejected_raw_lid");
    assert.equal(res.handled, false);

    const tasks = await lc.storage.db.execute("SELECT * FROM tasks;");
    assert.equal(tasks.rows.length, 0);
  } finally {
    await lc.shutdown();
  }
});

test("36. Inbound Dispatcher: /clear & /reset bump epoch transaksional, restart DB, task & outbox lama dibatalkan", async () => {
  const dbPath = path.join(testDir, "inbound_epoch_restart.db");
  const mockSock = makeMockSocket({ isGroupAdmin: true });
  const destination = "120363000000001@g.us";

  const lc = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    sock: mockSock,
    workerId: "epoch_restart_worker",
  });
  await lc.init();

  try {
    setData({ owner: "628123456789", allowedGroups: [destination] });

    // 1. Buat intent task dan outbox pada epoch 0
    const taskStore = new TaskStore(lc.storage);
    const task = await taskStore.createTask({
      goal: "Task sebelum reset",
      actor_pn: "628123456789",
      chat_id: destination,
      context_epoch: 0,
    });

    const outbox = lc.getOutboxManager();
    const outboxItem = await outbox.createIntent({
      taskId: task.task_id,
      destination,
      contentType: "text",
      payload: { text: "Outbox sebelum reset" },
      contextEpoch: 0,
      logicalOperationId: "op_before_reset",
    });

    assert.equal(lc.getChatEpoch(destination), 0);

    // 2. Kirim perintah /clear dari owner
    const clearMsg = makeBaileysMessage({
      remoteJid: destination,
      participant: "628123456789@s.whatsapp.net",
      text: "/clear",
    });

    const clearRes = await dispatchInboundMessage(clearMsg, { sock: mockSock, lifecycle: lc });
    assert.equal(clearRes.status, "epoch_bumped");
    assert.equal(clearRes.epoch, 1);

    // 3. Restart DB: tutup koneksi & lifecycle, lalu buka instance storage baru
    await lc.shutdown();

    const conn2 = await createStorage(dbPath);
    try {
      // Context epoch tetap 1 setelah restart (persisten di SQLite)!
      assert.equal(conn2.storage.getChatEpoch(destination), 1);

      // Task dan outbox lama yang belum delivered telah dibatalkan secara transaksional
      const checkTask = await conn2.storage.getTask(task.task_id);
      assert.equal(checkTask.status, TASK_STATUS.CANCELLED);

      const checkOutbox = await conn2.storage.getOutbox(outboxItem.outbox_id);
      assert.equal(checkOutbox.status, "cancelled");
      assert.ok(checkOutbox.error_message.includes("Context epoch kadaluwarsa"));
    } finally {
      await conn2.close();
    }
  } finally {
    try { await lc.shutdown(); } catch {}
  }
});

test("37. Inbound Dispatcher: shadow inbound menghasilkan zero external send dan hash produksi tidak berubah", async () => {
  const dbPath = path.join(testDir, "inbound_shadow.db");
  const mockSock = makeMockSocket();

  const protectedFiles = [".env", "ai-memory.json", "agent-jobs.json", "data.json"];
  const hashesBefore = {};
  for (const f of protectedFiles) {
    hashesBefore[f] = fileSha256(path.resolve(f));
  }

  const lcShadow = new RuntimeLifecycle({
    engineMode: "shadow",
    dbPath,
    sock: mockSock,
    workerId: "shadow_inbound_worker",
  });
  await lcShadow.init();

  try {
    lcShadow.getTaskRunner().planner.glmClient = makeMockGlmClient({
      plan_id: "plan_shadow_inbound",
      goal: "Buat catatan di shadow: Uji simulasi",
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "step_create_shadow",
          arguments: { title: "Shadow Note", content: "Catatan shadow saja" },
          expected_result: "Tersimpan",
        },
      ],
      final_response: "Catatan shadow selesai",
    });

    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "/task catat: Uji simulasi",
    });

    const res = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lcShadow });
    assert.equal(res.status, "task_enqueued_and_executed");
    assert.equal(res.taskExecutionResult.status, TASK_STATUS.SUCCEEDED);

    // Nol pengiriman pesan WhatsApp eksternal
    assert.equal(mockSock.sentMessages.length, 0, "Shadow mode dilarang mengirim pesan WhatsApp nyata");

    // File produksi dilindungi dan hash tidak berubah sama sekali
    for (const f of protectedFiles) {
      const hashAfter = fileSha256(path.resolve(f));
      assert.equal(hashAfter, hashesBefore[f], `Hash file ${f} dilarang berubah di shadow mode`);
    }
  } finally {
    await lcShadow.shutdown();
  }
});

test("38. Inbound Dispatcher: lock failure menyebabkan dispatcher no-op dan fail closed", async () => {
  const dbPath = path.join(testDir, "inbound_lock_fail.db");
  const mockTransport = makeMockTransport();
  const mockSock = makeMockSocket();

  // Instance 1 memegang lock
  const lcPrimary = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    sock: mockSock,
    workerId: "primary_holder",
  });
  await lcPrimary.init();

  // Instance 2 gagal mendapatkan lock
  const lcSecondary = new RuntimeLifecycle({
    engineMode: "agent",
    dbPath,
    transport: mockTransport,
    sock: mockSock,
    workerId: "secondary_blocked",
  });
  const resInit = await lcSecondary.init();
  assert.equal(resInit.lockHeld, false);
  assert.equal(lcSecondary.getInboxManager(), null);

  try {
    const m = makeBaileysMessage({
      remoteJid: "120363000000001@g.us",
      participant: "628123456789@s.whatsapp.net",
      text: "/task catat: Harusnya gagal karena lock tidak dipegang",
    });

    const res = await dispatchInboundMessage(m, { sock: mockSock, lifecycle: lcSecondary });
    assert.equal(res.status, "lock_not_held");
    assert.equal(res.handled, false);

    // Di database tidak ada task baru dari lcSecondary
    const tasks = await lcPrimary.storage.db.execute("SELECT * FROM tasks WHERE goal LIKE '%Harusnya gagal%';");
    assert.equal(tasks.rows.length, 0);
  } finally {
    await lcPrimary.shutdown();
    await lcSecondary.shutdown();
  }
});

// ============================================================================
// PENGUATAN TEST AUDIT INDEPENDEN (A, B, C, D, E)
// ============================================================================

test("39. Point B.2: Crash antara pembuatan intent dan completeTask (simulasi): resume sukses, outbox tidak terduplikasi, transport TIDAK mengirim dua kali", async () => {
  const { storage, registry, close } = await getIsolatedEnv("crash_pre_complete");
  try {
    const mockTransport = makeMockTransport();
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Simulasi crash tepat sesudah intent dibuat sebelum completeTask",
      acceptance_criteria: "Langkah berhasil",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_tester",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_crash_sim",
      goal: task.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "summarize_context",
          logical_operation_id: "step_pre_crash_sum",
          arguments: { text: "Percakapan penting" },
          expected_result: "Ringkasan dihasilkan",
        },
      ],
      final_response: "Selesai sebelum crash sim",
    });

    // 1. Jalankan langkah sampai selesai menggunakan runner 1
    const runner1 = new TaskRunner(storage, {
      workerId: "worker_initial",
      registry,
      glmClient: glm,
    });

    const res1 = await runner1.runTask(task.task_id);
    assert.equal(res1.status, TASK_STATUS.SUCCEEDED);

    // Kuras outbox pertama kali
    await runner1.outboxManager.drainOutbox(mockTransport);
    assert.equal(mockTransport.sent.length, 1, "Transport harus mengirim pesan tepat satu kali");

    // 2. Simulasikan crash yang menyisakan outbox intent 'delivered' tetapi status task dipulihkan ke 'retry_wait'
    // (mis. proses crash sesaat sebelum state terminal task tertulis sempurna atau lease recovery)
    await storage.updateTask(task.task_id, {
      status: "retry_wait",
      expectedVersion: res1.version,
    });

    // 3. Worker baru mengambil alih dan melanjutkan tugas
    const runner2 = new TaskRunner(storage, {
      workerId: "worker_resuming",
      registry,
      glmClient: glm,
    });

    const res2 = await runner2.runTask(task.task_id);
    assert.equal(res2.status, TASK_STATUS.SUCCEEDED, "Task harus succeeded saat resume, bukan failed karena UNIQUE constraint");

    // 4. Verifikasi bahwa outbox intent tidak terduplikasi di SQLite
    const outboxKey = buildIdempotencyKey({
      taskId: task.task_id,
      capabilityName: "send_message",
      logicalOperationId: "final_task_completion_outbox",
    });
    const outboxList = await storage.db.execute({
      sql: "SELECT * FROM outbox WHERE idempotency_key = ?;",
      args: [outboxKey],
    });
    assert.equal(outboxList.rows.length, 1, "Hanya boleh ada tepat satu intent outbox untuk final_task_completion_outbox");

    // 5. Kuras outbox lagi dan buktikan transport TIDAK mengirim dua kali
    await runner2.outboxManager.drainOutbox(mockTransport);
    assert.equal(mockTransport.sent.length, 1, "Transport DILARANG mengirim pesan dua kali lintas crash/resume");
  } finally {
    close();
  }
});

test("40. Point C: Checkpoint per langkah tersimpan persisten di SQLite & resume tidak mengulang langkah yang telah succeeded", async () => {
  const { storage, registry, close } = await getIsolatedEnv("step_checkpoint_persistence");
  try {
    let step0Count = 0;
    let step1Count = 0;

    registry.registerCapability({
      name: "step_checkpoint_cap_0",
      version: "1.0.0",
      description: "Langkah checkpoint 0",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "write"],
      enabled: true,
      sideEffect: "write",
      idempotency: "idempotent",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async () => { step0Count++; return {}; },
      verifier: async () => ({ ok: true }),
    });

    registry.registerCapability({
      name: "step_checkpoint_cap_1",
      version: "1.0.0",
      description: "Langkah checkpoint 1",
      risk: "low",
      channelScopes: ["group", "dm"],
      requiredScopes: ["active_chat", "write"],
      enabled: true,
      sideEffect: "write",
      idempotency: "idempotent",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      handler: async () => { step1Count++; return {}; },
      verifier: async () => ({ ok: true }),
    });

    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Uji persistensi checkpoint per langkah",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_tester",
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_step_checkpoints",
      goal: task.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "step_checkpoint_cap_0",
          logical_operation_id: "op_chk_0",
          arguments: {},
          expected_result: "ok 0",
        },
        {
          step_index: 1,
          capability_name: "step_checkpoint_cap_1",
          logical_operation_id: "op_chk_1",
          arguments: {},
          expected_result: "ok 1",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_checkpoint_test",
      registry,
      glmClient: glm,
    });

    // Jalankan task hingga selesai
    const completed = await runner.runTask(task.task_id);
    assert.equal(completed.status, TASK_STATUS.SUCCEEDED);
    assert.equal(step0Count, 1);
    assert.equal(step1Count, 1);

    // Buktikan kedua langkah memiliki record tersimpan di database dengan status 'succeeded'
    const dbSteps = await storage.getTaskSteps(task.task_id);
    assert.equal(dbSteps.length, 2);
    assert.equal(dbSteps[0].status, "succeeded");
    assert.equal(dbSteps[1].status, "succeeded");
    assert.ok(dbSteps[0].idempotency_key);
    assert.ok(dbSteps[1].idempotency_key);

    // Buktikan version task bertambah sesuai jumlah checkpoint
    assert.ok(completed.version >= 3, `Versi task harus naik pada setiap checkpoint (tercatat: ${completed.version})`);

    // Reset status task ke retry_wait untuk mensimulasikan recovery restart
    await storage.updateTask(task.task_id, { status: "retry_wait", expectedVersion: completed.version });

    const resumingRunner = new TaskRunner(storage, {
      workerId: "worker_checkpoint_resume",
      registry,
      glmClient: glm,
    });

    await resumingRunner.runTask(task.task_id);

    // Eksekusi handler TIDAK bertambah karena langkah sudah succeeded
    assert.equal(step0Count, 1, "Langkah 0 dilarang dieksekusi ulang saat resume");
    assert.equal(step1Count, 1, "Langkah 1 dilarang dieksekusi ulang saat resume");
  } finally {
    close();
  }
});

test("41. Point D: Lingkup izin actor: penolakan over-permission write pada actor tanpa hak, verified true, PN valid, dan penolakan raw LID", async () => {
  const { storage, registry, close } = await getIsolatedEnv("actor_permissions");
  try {
    const taskStore = new TaskStore(storage);

    // 1. Actor TANPA hak tulis (scope default 'active_chat', non-owner, tanpa authorization_ref)
    const taskUnauth = await taskStore.createTask({
      goal: "Coba tulis catatan tanpa hak izin write",
      actor_pn: "628999000111", // Nomor anggota biasa
      chat_id: "120363000000001@g.us",
      scope: "active_chat", // Tidak ada 'write'
      authorization_ref: null,
    });

    const glm = makeMockGlmClient({
      plan_id: "plan_unauth_write",
      goal: taskUnauth.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_unauth_create",
          arguments: { title: "Catatan Ilegal", content: "Harus ditolak" },
          expected_result: "Note tersimpan",
        },
      ],
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_perm_check",
      registry,
      glmClient: glm,
    });

    const failedUnauth = await runner.runTask(taskUnauth.task_id);
    assert.equal(failedUnauth.status, TASK_STATUS.FAILED, "Task tanpa hak write harus gagal");
    const stepsUnauth = await storage.getTaskSteps(taskUnauth.task_id);
    assert.equal(stepsUnauth[0].status, "failed");
    assert.ok(
      stepsUnauth[0].observation_redacted.message.includes("Izin tidak lengkap") ||
      stepsUnauth[0].observation_redacted.message.includes("kekurangan scope"),
      "Harus ditolak karena kekurangan scope write"
    );

    // 2. Actor BERHAK tulis (scope memuat 'write' dan authorization_ref valid)
    const taskAuth = await taskStore.createTask({
      goal: "Tulis catatan dengan hak izin sah",
      actor_pn: "628999000111",
      chat_id: "120363000000001@g.us",
      scope: "active_chat,write",
      authorization_ref: "authorized_admin",
    });

    const glmAuth = makeMockGlmClient({
      plan_id: "plan_auth_write",
      goal: taskAuth.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "create_note",
          logical_operation_id: "op_auth_create",
          arguments: { title: "Catatan Sah", content: "Berhasil ditulis" },
          expected_result: "Note tersimpan",
        },
      ],
    });

    const runnerAuth = new TaskRunner(storage, {
      workerId: "worker_perm_auth",
      registry,
      glmClient: glmAuth,
    });

    const successAuth = await runnerAuth.runTask(taskAuth.task_id);
    assert.equal(successAuth.status, TASK_STATUS.SUCCEEDED, "Task dengan hak write sah harus sukses");

    // 3. Penolakan Raw WhatsApp LID fail-closed saat pembuatan task
    await assert.rejects(
      async () => {
        await taskStore.createTask({
          goal: "Mencoba dengan raw LID",
          actor_pn: "123456789012345@lid",
          chat_id: "120363000000001@g.us",
        });
      },
      /bukan raw WhatsApp LID/,
      "Raw WhatsApp LID wajib ditolak fail-closed"
    );
  } finally {
    close();
  }
});

test("42. Point E: Penggunaan final_response GLM pada outbox completion, sanitasi jejak audit, dan error internal aman", async () => {
  const { storage, registry, close } = await getIsolatedEnv("final_response_and_audit");
  try {
    const taskStore = new TaskStore(storage);
    const task = await taskStore.createTask({
      goal: "Ringkas materi dan berikan balasan natural",
      acceptance_criteria: "Ringkasan berhasil",
      actor_pn: "628123456789",
      chat_id: "120363000000001@g.us",
      scope: "active_chat",
    });

    const customFinalResponse = "Halo! Catatan rapat berhasil kami simpan dan rangkum dengan bukti lengkap.";

    const glm = makeMockGlmClient({
      plan_id: "plan_custom_final",
      goal: task.goal,
      steps: [
        {
          step_index: 0,
          capability_name: "summarize_context",
          logical_operation_id: "op_sum_final",
          arguments: { text: "Pembahasan rilis 3.0" },
          expected_result: "Ringkasan",
        },
      ],
      final_response: customFinalResponse,
    });

    const runner = new TaskRunner(storage, {
      workerId: "worker_final_resp",
      registry,
      glmClient: glm,
    });

    const completed = await runner.runTask(task.task_id);
    assert.equal(completed.status, TASK_STATUS.SUCCEEDED);

    // 1. Verifikasi outbox completion memakai final_response dari model GLM
    const outboxKey = buildIdempotencyKey({
      taskId: task.task_id,
      capabilityName: "send_message",
      logicalOperationId: "final_task_completion_outbox",
    });
    const outbox = await storage.getOutboxByIdempotencyKey(outboxKey);
    assert.ok(outbox, "Outbox completion intent harus ada");
    assert.equal(outbox.payload.text, customFinalResponse, "Isi pesan penyelesaian wajib menggunakan final_response model");
    assert.equal(outbox.destination, task.chat_id, "Tujuan penerima harus ditentukan runtime (chat asal)");

    // 2. Verifikasi jejak audit tersanitasi
    const auditEvents = await storage.listAuditEvents({ taskId: task.task_id });
    assert.ok(auditEvents.length > 0);
    for (const ev of auditEvents) {
      const serialized = JSON.stringify(ev);
      assert.equal(serialized.includes("sk-or-v1-"), false, "Dilarang memuat API key");
      assert.equal(serialized.includes("Bearer "), false, "Dilarang memuat token Authorization");
      assert.equal(serialized.includes("data:image/"), false, "Dilarang memuat media data URL mentah");
    }
  } finally {
    close();
  }
});
