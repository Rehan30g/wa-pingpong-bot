const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { randomUUID } = require("node:crypto");

const CHAT_ID = "120363999999999@g.us";
const ACTOR_PN = "628123456789";

async function createHeadlessSession({ storage, glmClient } = {}) {
  const { routeTaskIntent } = require("../ai/runtime/intent-router");
  const { TaskStore } = require("../ai/runtime/task-state-machine");
  const { TaskRunner } = require("../ai/runtime/task-runner");
  const { createCapabilityRegistry } = require("../ai/capabilities/registry");
  const { registerMvpCapabilities } = require("../ai/capabilities/mvp-capabilities");
  const { createMemorySearchCapability, createMemoryRememberCapability, createMemoryCorrectCapability } = require("../ai/capabilities/memory-facts");
  const { redactObject } = require("../ai/observability/redact");
  const registry = createCapabilityRegistry();
  registerMvpCapabilities(registry, { storage });
  registry.registerCapability(createMemorySearchCapability({ storage }));
  registry.registerCapability(createMemoryRememberCapability({ storage }));
  registry.registerCapability(createMemoryCorrectCapability({ storage }));
  const runner = new TaskRunner(storage, { registry, glmClient, engineMode: "shadow" });
  const taskStore = new TaskStore(storage);
  let lastNoteId = null;

  async function run(command) {
    const intent = routeTaskIntent(command, { isGroup: true, addressedToBot: true, fromOwner: true });
    if (!intent || !["create_note", "read_note", "summarize_context", "memory_remember", "memory_search", "memory_correct"].includes(intent.intent)) throw new Error("Perintah tidak didukung dalam demo headless ini");
    const goal = intent.intent === "read_note" && !/note_[a-z0-9_-]+/i.test(intent.goal) && lastNoteId
      ? `${intent.goal}. Gunakan note ID ${lastNoteId}.` : intent.goal;
    const task = await taskStore.createTask({
      goal, acceptance_criteria: intent.acceptanceCriteria, actor_pn: ACTOR_PN,
      chat_id: CHAT_ID, source_event_id: `headless_${randomUUID()}`,
      scope: intent.scope, authorization_ref: "owner_task", context_epoch: await storage.getChatEpochAsync(CHAT_ID),
      provenance: "test_harness",
    });
    const completed = await runner.runTask(task.task_id);
    const steps = await storage.getTaskSteps(task.task_id);
    for (const step of steps) {
      const noteId = step.observation_redacted?.data?.note_id;
      if (step.status === "succeeded" && noteId) lastNoteId = noteId;
    }
    const final = [...(completed?.evidence_refs || [])].reverse().find((item) => item?.type === "plan_final_response")?.text || null;
    const error = [...(completed?.evidence_refs || [])].reverse().find((item) => item?.error);
    return redactObject({ task_id: task.task_id, status: completed?.status || "unknown", final_response: final, error: error?.code || error?.error || null, steps: steps.map((step) => ({ capability: step.capability_name, status: step.status, result: step.observation_redacted?.data || null })) });
  }
  return { run };
}

async function main() {
  require("dotenv").config({ quiet: true });
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum tersedia");
  const tempRoot = path.resolve(os.tmpdir());
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "grad-headless-"));
  process.env.AI_MEMORY_FILE = path.join(tempDir, "ai-memory.json");
  process.env.AGENT_JOBS_FILE = path.join(tempDir, "agent-jobs.json");
  process.env.RUNTIME_ENGINE_MODE = "shadow";
  let close = null;
  try {
    const db = await require("../ai/runtime/storage").createStorage(path.join(tempDir, "runtime.db"));
    close = db.close;
    const session = await createHeadlessSession({ storage: db.storage });
    const once = process.argv.indexOf("--once");
    if (once >= 0) {
      const result = await session.run(process.argv.slice(once + 1).join(" "));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== "succeeded") process.exitCode = 1;
      return;
    }
    process.stdout.write("Grad headless: /task catat, /task baca, /task ringkas. /exit untuk keluar. State sementara hilang saat keluar.\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const line = (await rl.question("grad> ")).trim();
        if (line === "/exit") break;
        if (!line) continue;
        try { process.stdout.write(`${JSON.stringify(await session.run(line), null, 2)}\n`); }
        catch (error) { process.stderr.write(`${String(error.message).slice(0, 200)}\n`); }
      }
    } finally { rl.close(); }
  } finally {
    if (close) await close();
    if (tempDir.startsWith(`${tempRoot}${path.sep}`) && path.basename(tempDir).startsWith("grad-headless-")) await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

if (require.main === module) main().catch((error) => { process.stderr.write(`Headless gagal: ${String(error.message).slice(0, 200)}\n`); process.exitCode = 1; });
module.exports = { createHeadlessSession };
