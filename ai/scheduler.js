const fs = require("fs");
const path = require("path");
const memoryStore = require("./memory-store");
const humanize = require("./humanize");

const JOBS_FILE = path.resolve(process.env.AGENT_JOBS_FILE || "./agent-jobs.json");
const MINUTE = 60_000;
const HOUR = 3_600_000;

let store = load();
let timer = null;
let activeSock = null;
let sequence = 0;

function load() {
  if (!fs.existsSync(JOBS_FILE)) return { jobs: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    return { jobs: Array.isArray(raw.jobs) ? raw.jobs : [] };
  } catch (error) {
    console.warn("[AGENT] File jadwal tidak dapat dibaca, memakai kosong:", error.message);
    return { jobs: [] };
  }
}

function save() {
  const dir = path.dirname(JOBS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, JOBS_FILE);
  fs.chmodSync(JOBS_FILE, 0o600);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function agentConfig() {
  const savedEnabled = memoryStore.getAgentSettings().enabled;
  return {
    enabled: typeof savedEnabled === "boolean"
      ? savedEnabled
      : String(process.env.AI_AGENT_ENABLED ?? "true") !== "false",
    proactive: String(process.env.AI_AGENT_PROACTIVE ?? "true") !== "false",
    tickMs: Math.max(1_000, envNumber("AI_AGENT_TICK_MS", 60_000)),
    dailyLimit: Math.max(0, envNumber("AI_AGENT_DAILY_PROACTIVE_LIMIT", 5)),
    personCooldownMs: Math.max(0, envNumber("AI_AGENT_PERSON_COOLDOWN_HOURS", 20)) * HOUR,
    activeDays: Math.max(1, envNumber("AI_AGENT_ACTIVE_DAYS", 7)),
  };
}

function phoneJid(phone) {
  return `${memoryStore.normalizePhone(phone)}@s.whatsapp.net`;
}

function nextId() {
  sequence += 1;
  return `job-${Date.now().toString(36)}-${sequence}`;
}

function scheduleJob({ type, fire_at, payload = {} } = {}) {
  if (!type || !Number.isFinite(Number(fire_at))) return null;
  const job = {
    id: nextId(),
    type,
    fire_at: Number(fire_at),
    payload,
    created_at: Date.now(),
    attempts: 0,
  };
  store.jobs.push(job);
  save();
  return job;
}

function cancelJob(id) {
  const before = store.jobs.length;
  store.jobs = store.jobs.filter((job) => job.id !== id);
  if (store.jobs.length !== before) save();
  return before !== store.jobs.length;
}

function listJobs() {
  return [...store.jobs].sort((a, b) => a.fire_at - b.fire_at);
}

function clearJobs() {
  store = { jobs: [] };
  save();
}

function todayProactiveCount(at = Date.now()) {
  const day = memoryStore.witDay(at);
  return memoryStore.listPeople()
    .filter((person) => person.dm?.proactive_day === day)
    .reduce((total, person) => total + (person.dm?.proactive_count || 0), 0);
}

function canProactivelyMessage(phone, at = Date.now(), cfg = agentConfig()) {
  const key = memoryStore.normalizePhone(phone);
  if (!cfg.enabled || !cfg.proactive) return false;
  if (!memoryStore.canDirectMessage(key)) return false;
  if (humanize.isQuietHours(at)) return false;
  const dm = memoryStore.getDmMemory(key);
  if (dm.opt_out) return false;
  if (dm.last_proactive_at && at - dm.last_proactive_at < cfg.personCooldownMs) return false;
  if (todayProactiveCount(at) >= cfg.dailyLimit) return false;
  return true;
}

function isRecentlyActive(phone, at = Date.now(), cfg = agentConfig()) {
  const person = memoryStore.getPerson(phone);
  if (!person?.last_seen_wit) return false;
  const parsed = Date.parse(String(person.last_seen_wit).replace(" WIT", "Z"));
  if (!Number.isFinite(parsed)) return false;
  // last_seen_wit memakai zona WIT (UTC+9); koreksi agar perbandingan benar.
  const seenAt = parsed - 9 * HOUR;
  return at - seenAt <= cfg.activeDays * 24 * HOUR;
}

async function sendDirect(sock, phone, text, { proactive = false, at = Date.now() } = {}) {
  const key = memoryStore.normalizePhone(phone);
  const jid = phoneJid(key);
  try {
    await sock?.sendPresenceUpdate?.("composing", jid);
  } catch {}
  await humanize.sleep(humanize.replyDelayMs(text, { min: 300, max: 1_200 }));
  await sock.sendMessage(jid, { text });
  try {
    await sock?.sendPresenceUpdate?.("paused", jid);
  } catch {}
  memoryStore.noteBotDm(key, { at, proactive });
  return { jid, text };
}

async function runJob(job, { sock, at = Date.now() } = {}) {
  const cfg = agentConfig();
  const phone = memoryStore.normalizePhone(job.payload?.phone);
  if (!phone) return { ...job, status: "invalid" };

  if (job.type === "reminder" || job.type === "follow_up") {
    if (!memoryStore.canDirectMessage(phone)) return { ...job, status: "blocked" };
    if (memoryStore.getDmMemory(phone).opt_out) return { ...job, status: "opt_out" };
    await sendDirect(sock, phone, job.payload?.text || "Mengingatkan sesuai permintaanmu ya.", { proactive: false, at });
    return { ...job, status: "sent" };
  }

  if (job.type === "proactive_checkin") {
    if (!canProactivelyMessage(phone, at, cfg)) return { ...job, status: "blocked" };
    const directAgent = require("./direct-agent");
    const text = await directAgent.generateProactive(phone, { reason: job.payload?.reason || "menyapa dan menanyakan kabar" });
    if (!text) return { ...job, status: "empty" };
    await sendDirect(sock, phone, text, { proactive: true, at });
    return { ...job, status: "sent", text };
  }

  return { ...job, status: "unknown_type" };
}

async function runDueJobs({ sock = activeSock, at = Date.now() } = {}) {
  const cfg = agentConfig();
  if (!cfg.enabled) return [];
  const due = store.jobs.filter((job) => job.fire_at <= at);
  if (!due.length) return [];
  const remaining = store.jobs.filter((job) => job.fire_at > at);
  store.jobs = remaining;
  save();

  const results = [];
  for (const job of due) {
    try {
      results.push(await runJob(job, { sock, at }));
    } catch (error) {
      console.error(`[AGENT] Job ${job.type} gagal:`, error.response?.data?.error?.message || error.message);
      results.push({ ...job, status: "error" });
      store.jobs.push({ ...job, attempts: (job.attempts || 0) + 1, fire_at: at + 5 * MINUTE });
    }
  }
  save();
  return results;
}

function maybeScheduleProactive({ at = Date.now() } = {}) {
  const cfg = agentConfig();
  if (!cfg.enabled || !cfg.proactive) return null;
  if (humanize.isQuietHours(at)) return null;
  if (todayProactiveCount(at) >= cfg.dailyLimit) return null;
  if (store.jobs.some((job) => job.type === "proactive_checkin")) return null;

  const candidate = memoryStore.listPeople()
    .filter((person) => canProactivelyMessage(person.phone, at, cfg))
    .filter((person) => isRecentlyActive(person.phone, at, cfg))
    .sort((a, b) => (a.dm?.last_proactive_at || 0) - (b.dm?.last_proactive_at || 0))[0];
  if (!candidate) return null;

  return scheduleJob({
    type: "proactive_checkin",
    fire_at: at + 1 * MINUTE + Math.floor(Math.random() * 5 * MINUTE),
    payload: { phone: candidate.phone, reason: "menyapa dan menanyakan kabar" },
  });
}

async function tick({ sock = activeSock, at = Date.now() } = {}) {
  const results = await runDueJobs({ sock, at });
  maybeScheduleProactive({ at });
  return results;
}

function start({ sock } = {}) {
  stop();
  if (sock) activeSock = sock;
  if (!agentConfig().enabled) return null;
  timer = setInterval(() => {
    tick({ sock: activeSock }).catch((error) => console.error("[AGENT] Tick gagal:", error.message));
  }, agentConfig().tickMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function setEnabled(value) {
  memoryStore.setAgentSettings({ enabled: Boolean(value) });
  if (!value) stop();
  return agentConfig().enabled;
}

function status(at = Date.now()) {
  const cfg = agentConfig();
  return {
    enabled: cfg.enabled,
    proactive: cfg.proactive,
    jobs: listJobs().length,
    nextJobs: listJobs().slice(0, 5),
    proactiveToday: todayProactiveCount(at),
    dailyLimit: cfg.dailyLimit,
    quiet: humanize.isQuietHours(at),
    running: Boolean(timer),
  };
}

module.exports = {
  agentConfig,
  canProactivelyMessage,
  cancelJob,
  clearJobs,
  isRecentlyActive,
  listJobs,
  maybeScheduleProactive,
  phoneJid,
  runDueJobs,
  runJob,
  scheduleJob,
  setEnabled,
  start,
  status,
  stop,
  tick,
  todayProactiveCount,
  JOBS_FILE,
};
