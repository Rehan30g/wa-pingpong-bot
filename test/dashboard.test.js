const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-dashboard-");

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const { createDashboard, loadOrCreateToken } = require("../ai/dashboard/server");
const activity = require("../ai/observability/activity");
const features = require("../ai/features");
const runtimeSettings = require("../ai/runtime-settings");
const { resetStickerCollector } = require("../ai/stickers/collector");

const GROUP = "120363666666666@g.us";
const TOKEN = "ab".repeat(24);
let dashboard;
let port;

test.before(async () => {
  dashboard = createDashboard({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    context: {
      startedAt: Date.now() - 65_000,
      isConnected: () => true,
      botUser: () => "628000@s.whatsapp.net",
      getData: () => ({ allowedGroups: [GROUP] }),
      groupSubject: async () => "Grup Tester",
    },
  });
  ({ port } = await dashboard.start());
});

test.after(async () => {
  await dashboard.stop();
  await resetStickerCollector();
  cleanup();
});

function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const cookie = { Cookie: `grad_dash=${TOKEN}` };
const post = (path, body, extra = {}) => request(path, {
  method: "POST",
  body,
  headers: { ...cookie, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...extra },
});

test("token: tanpa token ditolak, link ?t= memasang cookie HttpOnly lalu redirect", async () => {
  assert.equal((await request("/")).status, 401);
  assert.equal((await request("/api/overview")).status, 401);
  assert.equal((await request(`/?t=${"cd".repeat(24)}`)).status, 401);
  const login = await request(`/?t=${TOKEN}`);
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, "/");
  assert.match(login.headers["set-cookie"][0], new RegExp(`grad_dash=${TOKEN}; HttpOnly; SameSite=Strict`));
  const page = await request("/", { headers: cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Grad · Dashboard<\/title>/);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
});

test("anti DNS rebinding: Host asing ditolak walau token benar", async () => {
  const res = await request("/api/overview", { headers: { ...cookie, Host: `evil.example:${port}` } });
  assert.equal(res.status, 421);
});

test("anti CSRF: perubahan wajib Origin sendiri dan JSON", async () => {
  const body = { groupId: GROUP, feature: "stiker", enabled: false };
  assert.equal((await request("/api/groups/feature", { method: "POST", body, headers: { ...cookie, "Content-Type": "application/json" } })).status, 403, "tanpa Origin");
  assert.equal((await post("/api/groups/feature", body, { Origin: "http://evil.example" })).status, 403, "Origin asing");
  assert.equal((await post("/api/groups/feature", "groupId=x", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415, "form HTML biasa");
  assert.equal(features.isEnabled(GROUP, "stiker"), true, "belum berubah");
});

test("ringkasan dan grup: data lengkap, toggle fitur & kunci global lewat dashboard tercatat", async () => {
  const overview = (await request("/api/overview", { headers: cookie })).json;
  assert.equal(overview.connected, true);
  assert.equal(overview.groups, 1);
  assert.ok(overview.uptimeMs >= 65_000);
  assert.ok("tasks" in overview.usage && "dailyUsd" in overview.budget);

  const toggled = await post("/api/groups/feature", { groupId: GROUP, feature: "stiker", enabled: false });
  assert.equal(toggled.status, 200);
  assert.equal(features.isEnabled(GROUP, "stiker"), false);
  assert.equal((await post("/api/groups/feature", { groupId: "120363999999999@g.us", feature: "web", enabled: false })).status, 400, "grup yang tidak diizinkan bot ditolak");

  assert.equal((await post("/api/features/global", { feature: "web", locked: true })).status, 200);
  const groups = (await request("/api/groups", { headers: cookie })).json;
  assert.equal(groups.groups[0].subject, "Grup Tester");
  assert.equal(groups.groups[0].features.find((f) => f.name === "web").locked, true);
  assert.ok(groups.log.some((entry) => entry.role === "dashboard" && entry.feature === "stiker"));
  await post("/api/features/global", { feature: "web", locked: false });
});

test("pengaturan: hanya whitelist, tervalidasi, langsung berlaku, dan tersimpan", async () => {
  const unknown = await post("/api/settings", { key: "OPENROUTER_API_KEY", value: "sk-or-v1-curian" });
  assert.equal(unknown.status, 400);
  assert.notEqual(process.env.OPENROUTER_API_KEY, "sk-or-v1-curian");
  assert.equal((await post("/api/settings", { key: "STICKER_REACTION_CHANCE", value: 5 })).status, 400, "di luar batas");
  const ok = await post("/api/settings", { key: "STICKER_REACTION_CHANCE", value: 0.5 });
  assert.equal(ok.status, 200);
  assert.equal(process.env.STICKER_REACTION_CHANCE, "0.5");
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.RUNTIME_SETTINGS_FILE, "utf8")), { STICKER_REACTION_CHANCE: 0.5 });
  const list = (await request("/api/settings", { headers: cookie })).json.settings;
  assert.ok(!list.some((s) => /KEY|TOKEN|SECRET/.test(s.key)), "tidak ada secret di daftar");
  assert.equal(list.find((s) => s.key === "STICKER_REACTION_CHANCE").overridden, true);

  delete process.env.STICKER_REACTION_CHANCE;
  runtimeSettings.applySavedSettings();
  assert.equal(process.env.STICKER_REACTION_CHANCE, "0.5", "dimuat ulang saat start");
});

test("stiker: gambar hanya lewat sha hex (tanpa path traversal); API stiker & memori & jadwal jalan", async () => {
  assert.equal((await request("/api/stickers/image?sha=../../.env", { headers: cookie })).status, 400);
  assert.equal((await request(`/api/stickers/image?sha=${"a".repeat(64)}`, { headers: cookie })).status, 404);
  const stickers = (await request("/api/stickers", { headers: cookie })).json;
  assert.ok(Array.isArray(stickers.collection) && "candidates" in stickers.stats);
  const memory = (await request("/api/memory", { headers: cookie })).json;
  assert.equal(memory.groups[0].id, GROUP);
  assert.equal((await post("/api/memory/clear", { groupId: "bukan-grup", mode: "reset" })).status, 400);
  assert.equal((await post("/api/memory/clear", { groupId: GROUP, mode: "clear" })).status, 200);
  assert.ok(Array.isArray((await request("/api/jobs", { headers: cookie })).json.jobs));
  assert.equal((await post("/api/jobs/cancel", { id: "tidak-ada" })).status, 404);
});

test("aktivitas live lewat Server-Sent Events", async () => {
  const received = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}`, ...cookie } }, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        const match = buffer.match(/data: (.+)\n\n/);
        if (match) { req.destroy(); resolve(JSON.parse(match[1])); }
      });
      setTimeout(() => activity.record("task", { chat: GROUP, status: "done", steps: 1, tools: {}, tokens: 10, cost: 0, durationMs: 5 }), 50);
    });
    req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    req.end();
  });
  assert.equal(received.type, "task");
  assert.equal(received.chat, GROUP);
  const recent = (await request("/api/activity?limit=5", { headers: cookie })).json.entries;
  assert.ok(recent.some((entry) => entry.type === "task"));
});

test("token tersimpan di file dan tetap sama saat dibaca ulang", () => {
  const first = loadOrCreateToken(process.env.DASHBOARD_TOKEN_FILE);
  assert.match(first, /^[a-f0-9]{48}$/);
  assert.equal(loadOrCreateToken(process.env.DASHBOARD_TOKEN_FILE), first);
});
