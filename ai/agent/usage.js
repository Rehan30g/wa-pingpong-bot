// Pemakaian & budget harian agent loop (Plan v2 §6.7, §9). Disimpan di
// settings ai-memory.json supaya bertahan saat restart.
const memoryStore = require("../memory-store");
const { maskPhone } = require("../observability/redact");
const activity = require("../observability/activity");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function budgetConfig() {
  return {
    dailyUsd: Math.max(0, envNumber("AGENT_DAILY_BUDGET_USD", 3)),
    taskUsd: Math.max(0, envNumber("AGENT_TASK_BUDGET_USD", 0.15)),
  };
}

function emptyDay(day) {
  return { day, tasks: 0, steps: 0, tokens: 0, cost: 0, searches: 0, fetches: 0, audio: 0 };
}

function today(at = Date.now()) {
  const day = memoryStore.witDay(at);
  const saved = memoryStore.getAgentSettings().usage;
  return saved?.day === day ? { ...emptyDay(day), ...saved } : emptyDay(day);
}

function save(usage) {
  try {
    memoryStore.setAgentSettings({ usage });
  } catch (error) {
    console.warn("[AGENT] Pemakaian tidak tersimpan:", error.message);
  }
}

// Budget habis → loop tetap membalas, tetapi tanpa tools (jalur termurah).
function dailyBudgetLeft(at = Date.now()) {
  const { dailyUsd } = budgetConfig();
  return dailyUsd - today(at).cost;
}

function recordTask({ steps = 0, tokens = 0, cost = 0, searches = 0, fetches = 0 } = {}, at = Date.now()) {
  const usage = today(at);
  usage.tasks += 1;
  usage.steps += steps;
  usage.tokens += tokens;
  usage.cost = Number((usage.cost + cost).toFixed(6));
  usage.searches += searches;
  usage.fetches += fetches;
  save(usage);
  return usage;
}

function recordAudio({ cost = 0 } = {}, at = Date.now()) {
  const usage = today(at);
  usage.audio += 1;
  usage.cost = Number((usage.cost + cost).toFixed(6));
  save(usage);
  return usage;
}

function maskChat(chatId) {
  const value = String(chatId || "");
  if (value.endsWith("@g.us")) return `grup:${value.slice(-8, -5)}`;
  return `dm:${maskPhone(value.replace(/^dm:/, "").replace(/@.*/, ""))}`;
}

// Satu baris log per tugas: tanpa isi pesan dan tanpa secret.
function logTask(chatId, result) {
  const tools = Object.entries(result.toolCounts || {}).map(([name, count]) => `${name}×${count}`).join(",") || "-";
  activity.record("task", { chat: chatId, status: result.status, steps: result.steps, tools: result.toolCounts || {}, tokens: result.usage?.tokens || 0, cost: result.usage?.cost || 0, durationMs: result.durationMs });
  console.log(`[AGENT] chat=${maskChat(chatId)} status=${result.status} langkah=${result.steps} tools=${tools} token=${result.usage?.tokens || 0} biaya=$${(result.usage?.cost || 0).toFixed(4)} durasi=${result.durationMs}ms`);
}

module.exports = { budgetConfig, dailyBudgetLeft, logTask, maskChat, recordAudio, recordTask, today };
