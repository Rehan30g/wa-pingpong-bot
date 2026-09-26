// Tugas latar (subagent) untuk pekerjaan panjang: Grad langsung menjawab
// "oke, aku kerjain dulu", lalu subagent bekerja di belakang dengan batas yang
// lebih besar dan mengirim hasil ke chat asal (me-reply permintaannya).
// Chat tidak terblokir selama subagent bekerja.
const crypto = require("node:crypto");
const activity = require("../observability/activity");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function backgroundConfig() {
  return {
    maxPerChat: Math.max(1, envNumber("AGENT_BACKGROUND_MAX_PER_CHAT", 2)),
    maxPerDay: Math.max(1, envNumber("AGENT_BACKGROUND_MAX_PER_DAY", 20)),
    maxSteps: Math.max(5, envNumber("AGENT_BACKGROUND_MAX_STEPS", 40)),
    timeoutMs: Math.max(30_000, envNumber("AGENT_BACKGROUND_TIMEOUT_MS", 15 * 60_000)),
    budgetUsd: Math.max(0.01, envNumber("AGENT_BACKGROUND_BUDGET_USD", 0.5)),
  };
}

const tasks = new Map(); // id -> task
let started = { day: "", count: 0 };

function witDay(at = Date.now()) {
  return new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
}

function describe(task) {
  return { id: task.id, goal: task.goal, status: task.status, requester: task.requesterName, started_min_ago: Math.round((Date.now() - task.startedAt) / 60_000) };
}

function listForChat(chatId) {
  return [...tasks.values()].filter((task) => task.chatId === chatId && task.status === "running").map(describe);
}

/**
 * Mulai subagent. `run(task)` (dari group-agent) mengerjakan dan mengirim hasil.
 * @returns {{ok: true, id} | {error}}
 */
function start({ chatId, historyKey, isDm, goal, requesterId, requesterName, requestRef, run }) {
  const cfg = backgroundConfig();
  const text = String(goal || "").trim().slice(0, 1_500);
  if (!text) return { error: "tujuan tugas kosong" };
  if (listForChat(chatId).length >= cfg.maxPerChat) return { error: `sudah ada ${cfg.maxPerChat} tugas latar berjalan di chat ini; tunggu selesai atau batalkan` };
  const day = witDay();
  if (started.day !== day) started = { day, count: 0 };
  if (started.count >= cfg.maxPerDay) return { error: "kuota tugas latar hari ini habis" };
  started.count += 1;

  const controller = new AbortController();
  const task = {
    id: crypto.randomBytes(3).toString("hex"),
    chatId, historyKey, isDm, goal: text, requesterId, requesterName, requestRef,
    status: "running", startedAt: Date.now(), controller,
  };
  tasks.set(task.id, task);
  activity.record("background", { chat: chatId, id: task.id, state: "start", goal: text.slice(0, 120) });
  Promise.resolve()
    .then(() => run(task))
    .then((result) => {
      task.status = controller.signal.aborted ? "cancelled" : "done";
      activity.record("background", { chat: chatId, id: task.id, state: task.status, steps: result?.steps, cost: result?.usage?.cost, durationMs: Date.now() - task.startedAt });
    })
    .catch((error) => {
      task.status = "error";
      console.error(`[LATAR] Tugas ${task.id} gagal:`, String(error.message).slice(0, 200));
      activity.record("background", { chat: chatId, id: task.id, state: "error", error: String(error.message).slice(0, 160) });
      task.onError?.(error);
    })
    .finally(() => setTimeout(() => tasks.delete(task.id), 30 * 60_000).unref?.());
  return { ok: true, id: task.id };
}

function cancel(chatId, id) {
  const task = tasks.get(String(id || "").trim());
  if (!task || task.chatId !== chatId || task.status !== "running") return { error: "tugas latar dengan id itu tidak berjalan di chat ini" };
  task.controller.abort();
  task.status = "cancelled";
  return { ok: true, cancelled: describe(task) };
}

function reset() {
  for (const task of tasks.values()) task.controller.abort();
  tasks.clear();
  started = { day: "", count: 0 };
}

module.exports = { backgroundConfig, cancel, listForChat, reset, start, tasks };
