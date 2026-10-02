// Benchmark provider OpenRouter untuk model obrolan Grad (CHAT_MODEL) dengan prompt
// Grad sungguhan (persona + riwayat + daftar tools). Tiap provider dipaksa lewat
// `provider.only` tanpa fallback, supaya angka latensi/biaya benar-benar milik dia.
//   npm run bench:providers [-- --repeat 3 --providers baseten/fp8,together]
// Hasil JSON di data/bench/ (tidak masuk git).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setupSimulatorEnv } = require("./simulator-setup");
const { cleanup, tempDir } = setupSimulatorEnv();
require("dotenv").config({ quiet: true });
const scratch = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), "bench-prov-"));
for (const [key, name] of [["FEATURES_FILE", "features.json"], ["NOTEBOOK_FILE", "notebook.json"], ["STICKER_DIR", "stickers"], ["WORKSPACE_DIR", "workspace"]]) process.env[key] = path.join(scratch, name);

const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const groupAgent = require("../ai/group-agent");
const { toolDefinitions } = require("../ai/agent/tools");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const MODEL = process.env.CHAT_MODEL || "z-ai/glm-5.3-flash";
const REPEAT = Number(arg("repeat", 3));
const PROXY = process.env.OPENROUTER_PROXY_URL || process.env.HTTPS_PROXY || "http://127.0.0.1:8118";
const http = axios.create({
  baseURL: "https://openrouter.ai",
  timeout: 90_000,
  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  ...(PROXY ? { httpsAgent: new HttpsProxyAgent(PROXY), proxy: false } : {}),
});

const GROUP = "120363000000999@g.us";
const now = Date.now();
const HISTORY = [
  ["Dimas", "6281111110001", "bah hari ini panas sekali"],
  ["Yos", "6281111110002", "iya dim, sa su mandi 2 kali"],
  ["Rehan", "6281111110003", "besok jadi kumpul sabtu ka?"],
  ["Dimas", "6281111110001", "jadi, jam 4 sore di rumah rehan"],
].map(([sender, id, text], index) => ({ entry_id: index + 1, sender, sender_id: id, text, at: now - (10 - index) * 60_000, is_bot: false }));
const MEMORY = {
  glm: "Identitas: Rehan (6281111110003) pelajar, Dimas (6281111110001, 'dim') jualan headset, Yos (6281111110002). Mereka sering bercanda soal 'tim guguk'. Dimas sering minta bot menghitung untung-rugi dagangannya. Rencana kumpul Sabtu di rumah Rehan.",
  jev: "",
};

// Tiga bentuk beban: obrolan singkat, jawaban informatif, dan tugas bertool.
const TASKS = [
  { name: "singkat", sender: ["Yos", "6281111110002"], text: "@Grad lagi ngapain ko wkwk", expect: "text" },
  { name: "hitung", sender: ["Dimas", "6281111110001"], text: "@Grad modal + ongkir 245rb, udh laku 57rb, besok 114rb, temen ambil 171rb. untung apa rugi?", expect: "text", check: (text, tools) => /97/.test(text) || tools.includes("run_python") },
  { name: "tugas", sender: ["Rehan", "6281111110003"], text: "@Grad bikinin QR code buat link https://example.com/daftar terus ingetin aku besok jam 7 pagi buat ngecek pendaftarannya", expect: "tools" },
];

function buildPayload(task) {
  const latestMessage = { sender: task.sender[0], sender_id: task.sender[1], text: task.text };
  const history = [...HISTORY, { entry_id: 99, ...latestMessage, at: now, is_bot: false, mentioned_bot: true }];
  const features = new Set(["python", "reminder", "memori", "skill", "stiker", "media"]);
  const messages = groupAgent.buildChatMessages({ groupId: GROUP, latestMessage, historySnapshot: history, memorySnapshot: MEMORY, features, canReact: true });
  const tools = toolDefinitions({ features, python: {}, schedules: {}, notebook: {}, reaction: { emoji: null }, getHistory: () => history });
  return { model: MODEL, messages, tools, tool_choice: "auto", temperature: 0.35, max_tokens: 1_200, reasoning: { effort: "low", exclude: true }, usage: { include: true } };
}

async function endpoints() {
  const { data } = await http.get(`/api/v1/models/${MODEL}/endpoints`);
  return data.data.endpoints.filter((item) => (item.supported_parameters || []).includes("tools"));
}

async function callOnce(tag, task) {
  const payload = { ...buildPayload(task), ...(tag === "default" ? {} : { provider: { only: [tag], allow_fallbacks: false } }) };
  const started = Date.now();
  try {
    const { data } = await http.post("/api/v1/chat/completions", payload);
    const message = data.choices?.[0]?.message || {};
    const text = typeof message.content === "string" ? message.content : "";
    const calls = message.tool_calls || [];
    const validCalls = calls.filter((call) => { try { JSON.parse(call.function?.arguments || "{}"); return true; } catch { return false; } });
    const ok = task.expect === "tools" ? validCalls.length > 0 : (Boolean(text.trim()) || validCalls.length > 0) && (!task.check || task.check(text, validCalls.map((call) => call.function?.name)));
    return { ok, ms: Date.now() - started, provider: data.provider, cost: data.usage?.cost || 0, out: data.usage?.completion_tokens || 0, tools: calls.map((call) => call.function?.name), sample: text.slice(0, 160) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: `${error.response?.data?.error?.code || error.response?.status || ""} ${error.response?.data?.error?.metadata?.raw || error.response?.data?.error?.message || error.message}`.slice(0, 120) };
  }
}

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function benchProvider(tag) {
  const runs = [];
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const task of TASKS) runs.push({ task: task.name, ...(await callOnce(tag, task)) });
  }
  const byTask = Object.fromEntries(TASKS.map((task) => {
    const items = runs.filter((run) => run.task === task.name);
    const good = items.filter((run) => !run.error);
    return [task.name, { p50: pct(good.map((run) => run.ms), 50), max: good.length ? Math.max(...good.map((run) => run.ms)) : null, ok: `${items.filter((run) => run.ok).length}/${items.length}` }];
  }));
  const good = runs.filter((run) => !run.error);
  return {
    tag,
    byTask,
    errors: runs.filter((run) => run.error).length,
    cost: good.length ? good.reduce((sum, run) => sum + run.cost, 0) / good.length : null,
    served: [...new Set(good.map((run) => run.provider))].join(","),
    runs,
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum diset");
  const list = await endpoints();
  const wanted = arg("providers", null);
  const tags = wanted ? wanted.split(",") : ["default", ...list.map((item) => item.tag)];
  console.log(`Model ${MODEL}, ${tags.length} provider × ${TASKS.length} tugas × ${REPEAT} ulangan`);
  // Paralel antar provider (beban mereka terpisah), berurutan di dalam satu provider.
  const results = [];
  const queue = [...tags];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const tag = queue.shift();
      const result = await benchProvider(tag);
      results.push(result);
      console.log(`  selesai ${tag}`);
    }
  }));
  results.sort((a, b) => (a.byTask.singkat.p50 ?? 1e9) - (b.byTask.singkat.p50 ?? 1e9));
  console.log("\nprovider | singkat p50/max ok | hitung p50 ok | tugas p50 ok | $/panggilan | error");
  for (const r of results) {
    const t = r.byTask;
    const fmt = (x) => (x.p50 == null ? "-" : `${(x.p50 / 1000).toFixed(1)}s`);
    console.log(`${r.tag} | ${fmt(t.singkat)}/${t.singkat.max == null ? "-" : (t.singkat.max / 1000).toFixed(1) + "s"} ${t.singkat.ok} | ${fmt(t.hitung)} ${t.hitung.ok} | ${fmt(t.tugas)} ${t.tugas.ok} | ${r.cost == null ? "-" : r.cost.toFixed(5)} | ${r.errors}${r.tag === "default" ? ` (dilayani: ${r.served})` : ""}`);
  }
  const dir = path.resolve("data/bench");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `providers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: MODEL, repeat: REPEAT, results }, null, 2));
  console.log(`\nHasil lengkap: ${file}`);
}

main().catch((error) => { console.error("Benchmark gagal:", error.message); process.exitCode = 1; }).finally(() => cleanup());
