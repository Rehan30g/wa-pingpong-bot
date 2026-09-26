// Dashboard owner lokal (Plan v2 M2c). Hanya mendengarkan di 127.0.0.1 (atau
// DASHBOARD_HOST, mis. IP Tailscale). Di VPS diakses lewat SSH tunnel.
// Keamanan: token di file (cookie HttpOnly setelah link pertama), Host dicek
// (anti DNS rebinding), Origin + JSON wajib untuk perubahan (anti CSRF).
// Secret (.env, API key, auth/) tidak pernah dibaca atau dikirim dari sini.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const activity = require("../observability/activity");
const features = require("../features");
const runtimeSettings = require("../runtime-settings");
const usage = require("../agent/usage");
const memoryStore = require("../memory-store");
const scheduler = require("../scheduler");
const groupAgent = require("../group-agent");
const { getStickerCollector } = require("../stickers/collector");
const { getStickerLibrary } = require("../stickers/library");
const curator = require("../stickers/curator");

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const COOKIE = "grad_dash";

function dashboardConfig() {
  return {
    enabled: process.env.DASHBOARD_ENABLED !== "false",
    host: process.env.DASHBOARD_HOST || "127.0.0.1",
    port: Number(process.env.DASHBOARD_PORT) || 7777,
    tokenFile: path.resolve(process.env.DASHBOARD_TOKEN_FILE || "./data/dashboard-token"),
  };
}

// Token tetap walau restart, supaya link dari `npm run dashboard:link` tetap berlaku.
function loadOrCreateToken(tokenFile = dashboardConfig().tokenFile) {
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (/^[a-f0-9]{48}$/.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  try { fs.chmodSync(tokenFile, 0o600); } catch {}
  return token;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieToken(req) {
  const match = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return match?.[1] || "";
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": isBuffer ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(payload);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("json_invalid")); }
    });
    req.on("error", reject);
  });
}

const isGroupId = (value) => /^[0-9]{6,40}(-[0-9]+)?@g\.us$/.test(String(value || ""));

/**
 * @param {object} context disediakan index.js: isConnected(), botUser(), startedAt,
 *   getData() → { owner, allowedGroups }, groupSubject(id) async.
 */
function createDashboard({ context = {}, host, port, token } = {}) {
  const cfg = dashboardConfig();
  const listenHost = host || cfg.host;
  let listenPort = port ?? cfg.port;
  const accessToken = token || loadOrCreateToken(cfg.tokenFile);
  const sseClients = new Set();
  let server = null;
  let unsubscribe = null;

  const allowedHosts = () => new Set([`127.0.0.1:${listenPort}`, `localhost:${listenPort}`, `${listenHost}:${listenPort}`]);

  async function groupsWithSubjects() {
    const groups = context.getData?.().allowedGroups || [];
    return Promise.all(groups.map(async (id) => ({ id, subject: (await context.groupSubject?.(id).catch(() => null)) || id })));
  }

  const routes = {
    "GET /api/overview": async () => {
      const state = await scheduler.status();
      const stickerStats = await getStickerCollector().stats({ limit: 0 }).catch(() => null);
      return {
        connected: Boolean(context.isConnected?.()),
        botUser: context.botUser?.() || null,
        uptimeMs: context.startedAt ? Date.now() - context.startedAt : null,
        models: {
          jev: process.env.JEV_MODEL || "typesafe/jev-1.13",
          chat: process.env.CHAT_MODEL || "z-ai/glm-5.3-flash",
          audio: process.env.AUDIO_MODEL || "google/gemini-3.1-flash-lite",
        },
        agent: { enabled: state.enabled, emergencyPaused: scheduler.isEmergencyPaused(), jobs: state.jobs, quiet: state.quiet },
        usage: usage.today(),
        budget: usage.budgetConfig(),
        groups: (context.getData?.().allowedGroups || []).length,
        stickers: stickerStats && { collection: stickerStats.collection, candidates: stickerStats.candidates, usesLast24h: stickerStats.usesLast24h },
        memory: memoryStore.stats(),
      };
    },

    "POST /api/agent": async (body) => {
      if (typeof body.enabled === "boolean") {
        scheduler.setEnabled(body.enabled);
        activity.record("agent", { enabled: body.enabled, by: "dashboard" });
      }
      if (typeof body.emergencyPaused === "boolean") {
        scheduler.setEmergencyPaused(body.emergencyPaused);
        activity.record("agent", { emergencyPaused: body.emergencyPaused, by: "dashboard" });
      }
      return { ok: true };
    },

    "GET /api/groups": async () => ({
      groups: (await groupsWithSubjects()).map((group) => ({ ...group, features: features.statusFor(group.id) })),
      global: features.availableFeatures().map((name) => ({ name, label: features.FEATURES[name].label, locked: features.isLocked(name) })),
      log: features.recentLog(50),
    }),

    "POST /api/groups/feature": async (body) => {
      if (!isGroupId(body.groupId) || !(context.getData?.().allowedGroups || []).includes(body.groupId)) return [400, { error: "grup_tidak_dikenal" }];
      const result = features.setGroupFeature(body.groupId, String(body.feature), Boolean(body.enabled), { role: "dashboard" });
      return result.ok ? result : [400, result];
    },

    "POST /api/features/global": async (body) => {
      const result = features.setGlobalLock(String(body.feature), Boolean(body.locked), { role: "dashboard" });
      return result.ok ? result : [400, result];
    },

    "GET /api/activity": async (_body, url) => ({ entries: activity.recent(Math.min(300, Number(url.searchParams.get("limit")) || 100)) }),

    "GET /api/stickers": async () => {
      const library = getStickerLibrary();
      const stats = await getStickerCollector().stats({ limit: 20 });
      return {
        stats,
        collection: await library.listCollection(),
        decisions: await library.recentDecisions(40),
        lastCurationAt: Number(await library.getMeta("last_curation_at")) || null,
        lastReviewAt: Number(await library.getMeta("last_review_at")) || null,
      };
    },

    "GET /api/stickers/image": async (_body, url) => {
      const sha = String(url.searchParams.get("sha") || "");
      if (!/^[a-f0-9]{16,64}$/.test(sha)) return [400, { error: "sha_tidak_valid" }];
      const library = getStickerLibrary();
      const found = await library.findSticker(sha);
      if (!found?.file) return [404, { error: "tidak_ada" }];
      const file = path.resolve(library.store.dir, found.file);
      if (!file.startsWith(path.resolve(library.store.dir) + path.sep) || !fs.existsSync(file)) return [404, { error: "tidak_ada" }];
      return { raw: fs.readFileSync(file), type: "image/webp" };
    },

    "POST /api/stickers/curate": async () => curator.runCuration(),
    "POST /api/stickers/review": async () => curator.runWeeklyReview(),
    "POST /api/stickers/remove": async (body) => {
      const sha = String(body.sha || "");
      if (!/^[a-f0-9]{64}$/.test(sha)) return [400, { error: "sha_tidak_valid" }];
      const removed = await getStickerLibrary().remove(sha, { reason: String(body.reason || "dibuang owner lewat dashboard").slice(0, 200), source: "owner" });
      return removed ? { ok: true } : [404, { error: "tidak_ada_di_koleksi" }];
    },

    "GET /api/memory": async () => {
      const groups = await groupsWithSubjects();
      return {
        groups: groups.map((group) => {
          const memory = memoryStore.getGroupMemory(group.id);
          return { ...group, glm: memory.glm, jev: memory.jev, updatedAt: memory.updated_at_wit || null, active: groupAgent.getHistory(group.id).length };
        }),
        people: memoryStore.listPeople().map((person) => ({
          phone: person.phone, name: person.name, profile: person.profile || "", relation: person.relation || "",
          lastSeen: person.last_seen_wit || null, groups: person.groups || [],
        })),
      };
    },

    "POST /api/memory/clear": async (body) => {
      if (!isGroupId(body.groupId)) return [400, { error: "grup_tidak_dikenal" }];
      if (body.mode === "reset") groupAgent.resetGroupContext(body.groupId);
      else groupAgent.clearConversation(body.groupId);
      activity.record("memory", { chat: body.groupId, mode: body.mode === "reset" ? "reset" : "clear", by: "dashboard" });
      return { ok: true };
    },

    "GET /api/jobs": async () => ({ jobs: await scheduler.listJobs() }),
    "POST /api/jobs/cancel": async (body) => {
      const cancelled = await scheduler.cancelJob(String(body.id || ""));
      if (cancelled) activity.record("job", { id: body.id, action: "cancel", by: "dashboard" });
      return cancelled ? { ok: true } : [404, { error: "job_tidak_ada" }];
    },

    "GET /api/settings": async () => ({ settings: runtimeSettings.listSettings() }),
    "POST /api/settings": async (body) => {
      const result = runtimeSettings.setSetting(String(body.key || ""), body.value);
      return result.ok ? result : [400, result];
    },
  };

  function openEvents(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(": connected\n\n");
    const client = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    sseClients.add(client);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://dashboard.local");
    // Anti DNS rebinding: hanya Host lokal yang dikenal.
    if (!allowedHosts().has(String(req.headers.host || "").toLowerCase())) return send(res, 421, "host tidak diizinkan");

    const authed = safeEqual(cookieToken(req), accessToken);
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("t")) {
      if (!safeEqual(url.searchParams.get("t"), accessToken)) return send(res, 401, "token salah");
      return send(res, 302, "", { Location: "/", "Set-Cookie": `${COOKIE}=${accessToken}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!authed) return send(res, 401, "Butuh token. Buka link dari terminal bot, atau jalankan: npm run dashboard:link");

    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"), { "Content-Type": type });
    }
    if (req.method === "GET" && url.pathname === "/api/events") return openEvents(req, res);

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: "tidak_ada" });

    let body = {};
    if (req.method !== "GET") {
      // Anti CSRF: perubahan wajib dari halaman dashboard sendiri, berformat JSON.
      if (req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: "origin_ditolak" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "harus_json" });
      try { body = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    }
    try {
      const result = await route(body, url);
      if (Array.isArray(result)) return send(res, result[0], result[1]);
      if (result?.raw) return send(res, 200, result.raw, { "Content-Type": result.type });
      return send(res, 200, result);
    } catch (error) {
      console.error(`[DASHBOARD] ${req.method} ${url.pathname} gagal:`, error.message);
      return send(res, 500, { error: "gagal", detail: String(error.message).slice(0, 200) });
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { handle(req, res).catch((error) => send(res, 500, { error: error.message })); });
      server.on("error", reject);
      server.listen(listenPort, listenHost, () => {
        listenPort = server.address().port;
        unsubscribe = activity.subscribe((entry) => { for (const client of sseClients) client(entry); });
        resolve({ url: `http://${listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost}:${listenPort}/?t=${accessToken}`, port: listenPort });
      });
    });
  }

  function stop() {
    unsubscribe?.();
    sseClients.clear();
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.closeAllConnections?.();
      server.close(() => resolve());
      server = null;
    });
  }

  return { start, stop, get port() { return listenPort; }, token: accessToken };
}

let running = null;

// Dipanggil index.js saat bot start. Gagal (mis. port dipakai) tidak menghentikan bot.
async function startDashboard(context) {
  const cfg = dashboardConfig();
  if (!cfg.enabled || running) return running;
  if (!["127.0.0.1", "localhost", "::1"].includes(cfg.host)) console.warn(`[DASHBOARD] Mendengarkan di ${cfg.host}. Pastikan ini alamat privat (mis. Tailscale), bukan IP publik.`);
  try {
    const dashboard = createDashboard({ context });
    const { url } = await dashboard.start();
    running = dashboard;
    console.log(`[DASHBOARD] Dashboard owner: ${url}`);
    return dashboard;
  } catch (error) {
    console.warn(`[DASHBOARD] Tidak bisa dijalankan (${error.code || error.message}). Bot tetap jalan.`);
    return null;
  }
}

module.exports = { createDashboard, dashboardConfig, loadOrCreateToken, startDashboard };
