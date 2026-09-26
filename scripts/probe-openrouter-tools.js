// Probe M0: GLM + native tool calling + server tool openrouter:web_search dalam
// satu request, termasuk putaran balik hasil function tool ke GLM.
// Pakai: node scripts/probe-openrouter-tools.js [jumlah_percobaan]
// Proxy: OPENROUTER_PROXY_URL dipakai kecuali PROBE_NO_PROXY=1. API key tidak pernah dicetak.
require("dotenv").config({ quiet: true });
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const MODEL = process.env.PROBE_MODEL || process.env.CHAT_MODEL || "z-ai/glm-5.3-flash";
const TRIALS = Math.max(1, Number(process.argv[2]) || 3);
const BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai").replace(/\/$/, "");

function http() {
  const proxy = process.env.PROBE_NO_PROXY === "1" ? "" : process.env.OPENROUTER_PROXY_URL;
  return axios.create({
    baseURL: BASE,
    timeout: 180_000,
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    ...(proxy ? { httpsAgent: new HttpsProxyAgent(proxy), proxy: false } : {}),
  });
}

const FUNCTION_TOOLS = [{
  type: "function",
  function: {
    name: "get_wit_time",
    description: "Waktu sekarang di zona WIT (Asia/Jayapura). Panggil kalau butuh tanggal/jam hari ini.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}];
const TOOLS = [
  { type: "openrouter:web_search", parameters: { max_results: 5 } },
  ...FUNCTION_TOOLS,
];

function runFunction(name) {
  if (name === "get_wit_time") {
    return { now: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jayapura", dateStyle: "full", timeStyle: "short" }) + " WIT" };
  }
  return { error: `tool tidak dikenal: ${name}` };
}

async function trial(client, index) {
  const messages = [
    { role: "system", content: "Kamu Grad, anggota grup WhatsApp. Jawab ringkas bahasa Indonesia santai. Pakai tools kalau perlu data terbaru." },
    { role: "user", content: "@Grad hari ini tanggal berapa, dan harga iPhone 17 di Indonesia sekarang kisaran berapa? sebutin sumbernya" },
  ];
  const steps = [];
  const started = Date.now();
  let usage = { prompt: 0, completion: 0, cost: 0 };
  for (let step = 0; step < 6; step += 1) {
    const t0 = Date.now();
    const { data } = await client.post("/api/v1/chat/completions", {
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      reasoning: { effort: "low" },
      usage: { include: true },
    });
    const msg = data.choices?.[0]?.message || {};
    usage.prompt += data.usage?.prompt_tokens || 0;
    usage.completion += data.usage?.completion_tokens || 0;
    usage.cost += Number(data.usage?.cost || 0);
    const calls = msg.tool_calls || [];
    const citations = (msg.annotations || []).filter((a) => a.type === "url_citation");
    steps.push({
      ms: Date.now() - t0,
      provider: data.provider,
      finish: data.choices?.[0]?.finish_reason,
      tool_calls: calls.map((c) => c.function?.name),
      citations: citations.length,
      server_tool_use: data.usage?.server_tool_use || null,
    });
    if (!calls.length) {
      return {
        index,
        ok: Boolean(msg.content),
        total_ms: Date.now() - started,
        steps,
        usage,
        citation_hosts: [...new Set(citations.map((c) => { try { return new URL(c.url_citation.url).host; } catch { return "?"; } }))],
        answer: String(msg.content || "").slice(0, 400),
      };
    }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = { parse_error: true }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(runFunction(call.function?.name, args)) });
    }
  }
  return { index, ok: false, reason: "step_limit", total_ms: Date.now() - started, steps, usage };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY || /GANTI/.test(process.env.OPENROUTER_API_KEY)) {
    console.error("OPENROUTER_API_KEY belum diisi");
    process.exit(1);
  }
  const client = http();
  const results = [];
  for (let i = 1; i <= TRIALS; i += 1) {
    try {
      results.push(await trial(client, i));
    } catch (error) {
      results.push({ index: i, ok: false, status: error.response?.status, error: String(error.response?.data?.error?.message || error.message).slice(0, 300) });
    }
    console.log(JSON.stringify(results[results.length - 1], null, 2));
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\nRINGKASAN model=${MODEL} berhasil=${ok}/${TRIALS}`);
}

main();
