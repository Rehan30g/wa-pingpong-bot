const fs = require("fs");
const path = require("path");
const memoryStore = require("./memory-store");
const humanize = require("./humanize");
const engineConfig = require("./runtime/engine-config");
const { getGlobalLifecycle } = require("./runtime/lifecycle");

function getJobsFile() {
  return path.resolve(process.env.AGENT_JOBS_FILE || "./agent-jobs.json");
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

// ==========================================
// LEGACY SCHEDULER IMPLEMENTATION
// ==========================================

let lastLoadedFile = null;
let store = { jobs: [] };
let timer = null;
let activeSock = null;
let sequence = 0;
let emergencyPaused = false;

function loadLegacy() {
  const filePath = getJobsFile();
  if (!fs.existsSync(filePath)) return { jobs: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { jobs: Array.isArray(raw.jobs) ? raw.jobs : [] };
  } catch (error) {
    console.warn("[AGENT] File jadwal tidak dapat dibaca, memakai kosong:", error.message);
    return { jobs: [] };
  }
}

function getStore() {
  const currentFile = getJobsFile();
  if (currentFile !== lastLoadedFile) {
    store = loadLegacy();
    lastLoadedFile = currentFile;
  }
  return store;
}

function saveLegacy() {
  if (!engineConfig.canScheduleProductionJobs() || engineConfig.isShadow()) {
    // Mode shadow dilarang menulis ke agent-jobs.json produksi!
    return;
  }
  const filePath = getJobsFile();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(getStore(), null, 2), { mode: 0o600 });
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      try {
        fs.renameSync(temp, filePath);
      } catch (retryErr) {
        try { fs.unlinkSync(temp); } catch {}
        throw retryErr;
      }
    } else {
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
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

function nextLegacyId() {
  sequence += 1;
  return `job-${Date.now().toString(36)}-${sequence}`;
}

function legacyScheduleJob({ type, fire_at, payload = {} } = {}) {
  if (engineConfig.isShadow() || !engineConfig.canScheduleProductionJobs()) {
    throw new Error("Mode shadow dilarang menjadwalkan job legacy produksi");
  }
  if (!type || !Number.isFinite(Number(fire_at))) return null;
  const s = getStore();
  const job = {
    id: nextLegacyId(),
    type,
    fire_at: Number(fire_at),
    payload,
    created_at: Date.now(),
    attempts: 0,
  };
  s.jobs.push(job);
  saveLegacy();
  return job;
}

function legacyCancelJob(id) {
  const s = getStore();
  const before = s.jobs.length;
  s.jobs = s.jobs.filter((job) => job.id !== id);
  if (s.jobs.length !== before) saveLegacy();
  return before !== s.jobs.length;
}

function legacyListJobs() {
  return [...getStore().jobs].sort((a, b) => a.fire_at - b.fire_at);
}

function legacyClearJobs() {
  const s = getStore();
  s.jobs = [];
  saveLegacy();
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
  if (dm.opt_out || dm.proactive_consent !== true) return false;
  if (Number.isFinite(dm.last_user_dm_at) && at >= dm.last_user_dm_at && at - dm.last_user_dm_at < HOUR) return false;
  if (dm.last_proactive_at && at - dm.last_proactive_at < cfg.personCooldownMs) return false;
  if (todayProactiveCount(at) >= cfg.dailyLimit) return false;
  return true;
}

function isRecentlyActive(phone, at = Date.now(), cfg = agentConfig()) {
  const person = memoryStore.getPerson(phone);
  if (!person?.last_seen_wit) return false;
  const parsed = Date.parse(String(person.last_seen_wit).replace(" WIT", "Z"));
  if (!Number.isFinite(parsed)) return false;
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

// Tugas terjadwal (M3) menjalankan agent loop; runner dipasang group-agent
// supaya scheduler tidak bergantung langsung pada modul AI.
let chatTaskRunner = null;
function setChatTaskRunner(fn) {
  chatTaskRunner = typeof fn === "function" ? fn : null;
}

async function runChatJob(job, { sock, at }) {
  const { chatId, isDm, text } = job.payload || {};
  if (!chatId) return { ...job, status: "invalid" };
  const features = require("./features");
  if (!features.isEnabled(chatId, "reminder")) return { ...job, status: "feature_off" };
  if (isDm) {
    const phone = memoryStore.normalizePhone(chatId);
    if (!memoryStore.canDirectMessage(phone)) return { ...job, status: "blocked" };
  }
  if (job.type === "chat_task") {
    if (!chatTaskRunner) throw new Error("chat_task_runner_unavailable");
    const result = await chatTaskRunner({ sock, chatId, isDm, prompt: text, at });
    return { ...job, status: result?.sent ? "sent" : "empty" };
  }
  const message = `⏰ ${text}`;
  const sent = await sock.sendMessage(chatId, { text: message });
  const groupAgent = require("./group-agent");
  groupAgent.remember(isDm ? `dm:${memoryStore.normalizePhone(chatId)}` : chatId, {
    sender: groupAgent.config().botName, senderId: "BOT", text: message, isBot: true, messageKey: sent?.key, messageRef: sent,
  });
  return { ...job, status: "sent" };
}

async function legacyRunJob(job, { sock, at = Date.now() } = {}) {
  if (job.type === "chat_reminder" || job.type === "chat_task") return runChatJob(job, { sock, at });
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

// Reminder diminta pengguna, jadi tetap dikirim walau agen dimatikan owner.
const USER_REQUESTED_TYPES = new Set(["reminder", "chat_reminder", "chat_task"]);
const MAX_JOB_ATTEMPTS = 5;
// Token proses ini. Klaim dengan token lain berasal dari proses yang sudah mati
// (crash/restart di tengah pengiriman), jadi job itu boleh diklaim ulang.
const RUN_TOKEN = `${process.pid}-${Date.now().toString(36)}`;
let dueJobsQueue = Promise.resolve();

function isClaimedByLiveRun(job) {
  return Boolean(job.claimed_at) && job.claimed_by === RUN_TOKEN;
}

// Job diklaim (ditandai + disimpan) sebelum dijalankan dan baru dihapus setelah
// selesai, supaya crash di tengah pengiriman tidak menghilangkan reminder.
// Konsekuensinya at-least-once: crash tepat setelah terkirim bisa mengirim ulang.
async function legacyRunDueJobsOnce({ sock, at }) {
  if (emergencyPaused) return [];
  const cfg = agentConfig();
  const s = getStore();
  const due = s.jobs.filter((job) => job.fire_at <= at
    && !isClaimedByLiveRun(job)
    && (cfg.enabled || USER_REQUESTED_TYPES.has(job.type)));
  if (!due.length) return [];
  for (const job of due) {
    job.claimed_at = at;
    job.claimed_by = RUN_TOKEN;
    job.attempts = (job.attempts || 0) + 1;
  }
  saveLegacy();

  const results = [];
  for (const job of due) {
    const { claimed_at, claimed_by, ...clean } = job;
    try {
      results.push(await legacyRunJob(clean, { sock, at }));
      // Jadwal berulang (M3) maju ke kejadian berikutnya, bukan dihapus.
      const next = clean.payload?.recurrence ? require("./agent/schedules").nextOccurrence(clean.payload.recurrence, Math.max(at, clean.fire_at)) : null;
      if (next) {
        delete job.claimed_at;
        delete job.claimed_by;
        job.fire_at = next;
        job.attempts = 0;
      } else {
        s.jobs = s.jobs.filter((item) => item.id !== job.id);
      }
    } catch (error) {
      console.error(`[AGENT] Job ${job.type} gagal (percobaan ${job.attempts}):`, error.response?.data?.error?.message || error.message);
      results.push({ ...clean, status: "error" });
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        s.jobs = s.jobs.filter((item) => item.id !== job.id);
      } else {
        delete job.claimed_at;
        delete job.claimed_by;
        job.fire_at = at + Math.min(60, 2 ** (job.attempts - 1)) * MINUTE;
      }
    }
    saveLegacy();
  }
  return results;
}

function legacyRunDueJobs({ sock = activeSock, at = Date.now() } = {}) {
  // Tick yang tumpang tindih diantrikan agar job yang sama tidak jalan dua kali.
  const run = dueJobsQueue.catch(() => {}).then(() => legacyRunDueJobsOnce({ sock, at }));
  dueJobsQueue = run;
  return run;
}

function legacyMaybeScheduleProactive({ at = Date.now() } = {}) {
  if (emergencyPaused) return null;
  const cfg = agentConfig();
  if (!cfg.enabled || !cfg.proactive) return null;
  if (humanize.isQuietHours(at)) return null;
  if (todayProactiveCount(at) >= cfg.dailyLimit) return null;
  const s = getStore();
  if (s.jobs.some((job) => job.type === "proactive_checkin")) return null;

  const candidate = memoryStore.listPeople()
    .filter((person) => canProactivelyMessage(person.phone, at, cfg))
    .filter((person) => isRecentlyActive(person.phone, at, cfg))
    .sort((a, b) => (a.dm?.last_proactive_at || 0) - (b.dm?.last_proactive_at || 0))[0];
  if (!candidate) return null;

  return legacyScheduleJob({
    type: "proactive_checkin",
    fire_at: at + 1 * MINUTE + Math.floor(Math.random() * 5 * MINUTE),
    payload: { phone: candidate.phone, reason: "menyapa dan menanyakan kabar" },
  });
}

async function legacyTick({ sock = activeSock, at = Date.now() } = {}) {
  const results = await legacyRunDueJobs({ sock, at });
  legacyMaybeScheduleProactive({ at });
  return results;
}

// Timer selalu jalan (juga saat agen off) karena reminder pengguna tetap dikirim;
// gerbang enabled diterapkan per job di legacyRunDueJobsOnce.
function legacyStart({ sock } = {}) {
  legacyStop();
  if (sock) activeSock = sock;
  const runTick = () => {
    legacyTick({ sock: activeSock }).catch((error) => console.error("[AGENT] Tick gagal:", error.message));
  };
  timer = setInterval(runTick, agentConfig().tickMs);
  if (typeof timer.unref === "function") timer.unref();
  // Reminder yang jatuh tempo saat bot mati langsung dikirim begitu tersambung.
  if (activeSock) setImmediate(runTick);
  return timer;
}

function legacyStop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function legacyStatus(at = Date.now()) {
  const cfg = agentConfig();
  return {
    enabled: cfg.enabled,
    proactive: cfg.proactive,
    emergencyPaused,
    jobs: legacyListJobs().length,
    nextJobs: legacyListJobs().slice(0, 5),
    proactiveToday: todayProactiveCount(at),
    dailyLimit: cfg.dailyLimit,
    quiet: humanize.isQuietHours(at),
    running: Boolean(timer),
  };
}

// ==========================================
// DURABLE RESOLUTION (FOR SHADOW & AGENT)
// ==========================================

let activeDurableScheduler = null;

function setDurableScheduler(ds) {
  activeDurableScheduler = ds;
  return activeDurableScheduler;
}

function getDurableScheduler() {
  const lifecycle = getGlobalLifecycle();
  if (lifecycle && lifecycle.started && lifecycle.lockHeld && lifecycle.durableScheduler) {
    return lifecycle.durableScheduler;
  }
  return null;
}

function resolveDurableScheduler() {
  const lifecycle = getGlobalLifecycle();
  if (!lifecycle) {
    throw new Error("DURABLE_SCHEDULER_UNAVAILABLE: Lifecycle durable runtime belum diinisialisasi");
  }
  if (!lifecycle.lockHeld || !lifecycle.durableScheduler) {
    throw new Error("DURABLE_SCHEDULER_LOCK_FAILED: Lifecycle durable runtime gagal memegang process lock");
  }
  if (!lifecycle.started) {
    throw new Error("DURABLE_SCHEDULER_UNAVAILABLE: Lifecycle durable runtime belum dijalankan");
  }
  return lifecycle.durableScheduler;
}

// ==========================================
// UNIFIED ADAPTER EXPORTS
// ==========================================

function scheduleJob(opts) {
  if (engineConfig.isLegacy()) {
    return legacyScheduleJob(opts);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.scheduleJob(opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

function cancelJob(id) {
  if (engineConfig.isLegacy()) {
    return legacyCancelJob(id);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.cancelJob(id);
  } catch (err) {
    return Promise.reject(err);
  }
}

function clearJobs() {
  if (engineConfig.isLegacy()) {
    return legacyClearJobs();
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.clearJobs();
  } catch (err) {
    return Promise.reject(err);
  }
}

function listJobs(opts) {
  if (engineConfig.isLegacy()) {
    return legacyListJobs();
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.listJobs(opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

function status(at = Date.now()) {
  if (engineConfig.isLegacy()) {
    return legacyStatus(at);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.status(at);
  } catch (err) {
    return Promise.reject(err);
  }
}

function start({ sock } = {}) {
  if (engineConfig.isLegacy()) {
    return legacyStart({ sock });
  }
  const ds = resolveDurableScheduler();
  return ds.start({ sock });
}

function stop() {
  if (engineConfig.isLegacy()) {
    return legacyStop();
  }
  const ds = getDurableScheduler();
  if (ds) return ds.stop();
}

function setEnabled(value) {
  if (engineConfig.isShadow()) {
    throw new Error("Mode shadow dilarang memanggil API yang menulis memoryStore atau pengaturan agen produksi");
  }
  memoryStore.setAgentSettings({ enabled: Boolean(value) });
  if (engineConfig.isLegacy()) {
    return agentConfig().enabled;
  }
  const ds = getDurableScheduler();
  if (ds) ds.setEnabled(value);
  return agentConfig().enabled;
}

function setEmergencyPaused(value) {
  emergencyPaused = Boolean(value);
  if (!engineConfig.isLegacy()) {
    const ds = getDurableScheduler();
    if (ds) ds.setEmergencyPaused(value);
  }
  return emergencyPaused;
}

function isEmergencyPaused() {
  if (engineConfig.isLegacy()) {
    return emergencyPaused;
  }
  const ds = getDurableScheduler();
  return ds ? ds.isEmergencyPaused() : emergencyPaused;
}

function runDueJobs(opts) {
  if (engineConfig.isLegacy()) {
    return legacyRunDueJobs(opts);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.runDueJobs(opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

function runJob(job, opts) {
  if (engineConfig.isLegacy()) {
    return legacyRunJob(job, opts);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.runJob(job, opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

function maybeScheduleProactive(opts) {
  if (engineConfig.isLegacy()) {
    return legacyMaybeScheduleProactive(opts);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.maybeScheduleProactive(opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

function tick(opts) {
  if (engineConfig.isLegacy()) {
    return legacyTick(opts);
  }
  try {
    const ds = resolveDurableScheduler();
    return ds.tick(opts);
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = {
  agentConfig,
  setChatTaskRunner,
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
  setEmergencyPaused,
  isEmergencyPaused,
  start,
  status,
  stop,
  tick,
  todayProactiveCount,
  get JOBS_FILE() {
    return getJobsFile();
  },
  getJobsFile,
  setDurableScheduler,
  getDurableScheduler,
};
