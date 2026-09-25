const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setupSimulatorEnv } = require("./simulator-setup");
const simulator = setupSimulatorEnv();
require("dotenv").config({ quiet: true });

const { createStorage } = require("../ai/runtime/storage");
const { TaskStore } = require("../ai/runtime/task-state-machine");
const { TaskRunner } = require("../ai/runtime/task-runner");
const { createCapabilityRegistry } = require("../ai/capabilities/registry");
const { registerMvpCapabilities } = require("../ai/capabilities/mvp-capabilities");
const { createGlmClient } = require("../ai/providers/glm-client");

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum tersedia");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "grad-live-replan-"));
  let close = null;
  try {
    const db = await createStorage(path.join(dir, "runtime.db"));
    close = db.close;
    const { storage } = db;
    const chatId = "replan-test@g.us";
    const actorPn = "628123456789";
    const note = await storage.createNote({ chatId, ownerPn: actorPn, title: "Agenda", content: "Rapat tim jam 10. Bahas jadwal rilis." });
    const task = await new TaskStore(storage).createTask({
      goal: `Baca note ID ${note.note_id} di chat ini lalu ringkas agenda dalam satu kalimat.`,
      actor_pn: actorPn, chat_id: chatId, scope: "active_chat,read",
      acceptance_criteria: "Note yang benar berhasil dibaca dan ringkasan dibuat.",
    });
    const registry = createCapabilityRegistry();
    registerMvpCapabilities(registry, { storage });
    const liveGlm = createGlmClient();
    let modelCalls = 0;
    const glmClient = {
      chatCompletion: async (request) => {
        modelCalls++;
        if (modelCalls === 1) {
          return { text: JSON.stringify({ plan_id: "baseline_missing", goal: task.goal, steps: [{ step_index: 0, capability_name: "read_note", logical_operation_id: "baseline_lookup", arguments: { note_id: "missing_note" }, expected_result: "Note terbaca" }] }), usage: { total_tokens: 0 } };
        }
        return liveGlm.chatCompletion(request);
      },
    };
    const runner = new TaskRunner(storage, { registry, glmClient, engineMode: "shadow" });
    const result = await runner.runTask(task.task_id);
    const steps = await storage.getTaskSteps(task.task_id);
    const correctedRead = steps.some((step) => step.status === "succeeded" && step.capability_name === "read_note" && step.input_redacted?.note_id === note.note_id);
    if (result?.status !== "succeeded" || result.plan_version !== 2 || !correctedRead || modelCalls !== 2) {
      throw new Error(`Replan live gagal: status=${result?.status}, plan_version=${result?.plan_version}, correctedRead=${correctedRead}, modelCalls=${modelCalls}`);
    }
    process.stdout.write(`PASS: GLM live menghasilkan replan valid; ${steps.filter((s) => s.status === "succeeded").length} langkah terverifikasi; outbox belum dikirim.\n`);
  } finally {
    if (close) await close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    simulator.cleanup();
  }
}

main().catch((error) => { process.stderr.write(`FAIL: ${String(error.message).slice(0, 300)}\n`); process.exitCode = 1; });
