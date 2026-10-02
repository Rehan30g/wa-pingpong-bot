// Pemilih provider OpenRouter dari statistik live (owner 2 Okt 2026: "OpenRouter
// sudah menyediakan spek provider yang selalu update"). Sumber:
// GET /api/v1/models/<model>/endpoints → latency/throughput/uptime 30 menit terakhir + harga.
//
// Benchmark 2 Okt (35 provider, prompt Grad asli) menunjukkan `latency` di statistik
// = waktu sampai token pertama, bukan total: DigitalOcean tampak 0,7 dtk tapi nyatanya
// 3,3 dtk karena throughput 28 token/dtk. Maka perkiraan waktu = latency p50 +
// (token keluar termasuk reasoning) / throughput p50. Rate limit pool bersama (BaseTen
// 429) tidak terlihat di statistik → daftar selalu dipakai dengan allow_fallbacks.

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function pickerConfig() {
  return {
    refreshMs: Math.max(1, envNumber("GLM_PROVIDER_REFRESH_MIN", 15)) * 60_000,
    minUptime: envNumber("GLM_PROVIDER_MIN_UPTIME", 98),
    // Batas harga $/1 juta token supaya "cepat" tidak berarti mahal. Kosong = tarif
    // resmi pembuat model itu (z-ai, deepseek, …), karena dua model bisa dipakai bergantian.
    maxPromptPrice: envNumber("GLM_PROVIDER_MAX_PROMPT_PRICE", null),
    maxCompletionPrice: envNumber("GLM_PROVIDER_MAX_COMPLETION_PRICE", null),
    size: Math.max(1, envNumber("GLM_PROVIDER_LIST_SIZE", 4)),
  };
}

// Bentuk beban tipikal Grad (dari log [AGENT]): obrolan ±9 rb token masuk, tugas
// bertool ±20 rb token masuk; keluaran termasuk reasoning tersembunyi.
const PROFILES = {
  fast: { promptTokens: 9_000, outputTokens: 150 },
  balanced: { promptTokens: 20_000, outputTokens: 400 },
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function estimate(endpoint, profile) {
  const latency = num(endpoint.latency_last_30m?.p50 ?? endpoint.latency_last_30m);
  const tps = num(endpoint.throughput_last_30m?.p50 ?? endpoint.throughput_last_30m);
  const prompt = num(endpoint.pricing?.prompt) ?? 0;
  const completion = num(endpoint.pricing?.completion) ?? 0;
  if (latency == null || !tps) return null;
  return {
    tag: endpoint.tag || endpoint.provider_name,
    ms: latency + (profile.outputTokens / tps) * 1000,
    cost: profile.promptTokens * prompt + profile.outputTokens * completion,
    prompt: prompt * 1e6,
    completion: completion * 1e6,
    uptime: num(endpoint.uptime_last_30m),
  };
}

/**
 * Susun urutan provider dari daftar endpoint OpenRouter.
 *  - fast: tercepat (perkiraan waktu total), harga ≤ batas.
 *  - balanced: skor gabungan waktu/tercepat + biaya/termurah (bobot sama), harga ≤ batas.
 * @returns {{ fast: string[], balanced: string[] }}
 */
// Tarif resmi = endpoint milik pembuat model (tag "z-ai/fp8" untuk z-ai/glm-…);
// tanpa itu pakai median harga semua endpoint.
function officialPrice(endpoints, model) {
  const vendor = String(model || "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const own = vendor && endpoints.find((item) => String(item.tag || "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "") === vendor);
  const price = (item, key) => (num(item.pricing?.[key]) ?? 0) * 1e6;
  if (own) return { prompt: price(own, "prompt"), completion: price(own, "completion") };
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Infinity;
  return { prompt: median(endpoints.map((item) => price(item, "prompt"))), completion: median(endpoints.map((item) => price(item, "completion"))) };
}

function rankEndpoints(endpoints = [], cfg = pickerConfig(), model = null) {
  const official = officialPrice(endpoints, model);
  cfg = { ...cfg, maxPromptPrice: cfg.maxPromptPrice ?? official.prompt, maxCompletionPrice: cfg.maxCompletionPrice ?? official.completion };
  const usable = endpoints.filter((item) => (item.supported_parameters || []).includes("tools")
    && (num(item.uptime_last_30m) ?? 0) >= cfg.minUptime);
  const result = {};
  for (const tier of ["fast", "balanced"]) {
    const rows = usable.map((item) => estimate(item, PROFILES[tier])).filter(Boolean)
      .filter((row) => row.prompt <= cfg.maxPromptPrice + 1e-9 && row.completion <= cfg.maxCompletionPrice + 1e-9);
    // Tag ganda (mis. dua endpoint BaseTen) cukup sekali.
    const unique = (list) => [...new Set(list.map((row) => row.tag))].slice(0, cfg.size);
    if (tier === "fast") {
      result.fast = unique(rows.sort((a, b) => a.ms - b.ms));
    } else {
      const bestMs = Math.min(...rows.map((row) => row.ms));
      const bestCost = Math.min(...rows.map((row) => row.cost)) || 1e-9;
      const score = (row) => row.ms / bestMs + row.cost / bestCost;
      result.balanced = unique(rows.sort((a, b) => score(a) - score(b)));
    }
  }
  return result;
}

// Cache per model: obrolan (mis. DeepSeek) dan tugas (GLM) dipakai bergantian.
const caches = new Map(); // model → { at, ranking }
const inflight = new Map(); // model → Promise
// Provider yang dilewati OpenRouter (429 pool bersama, error) diturunkan sementara.
// Kuncinya model+provider: 429 untuk GLM belum tentu berlaku untuk model lain.
const demoted = new Map(); // "model|provider" → sampai kapan

const providerKey = (value) => String(value || "").split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Catat provider yang benar-benar melayani. Semua provider di depannya dalam urutan
 * berarti gagal/dilewati → diturunkan selama GLM_PROVIDER_DEMOTE_MIN menit.
 */
function noteServed(order = [], servedName, at = Date.now(), model = "") {
  const served = providerKey(servedName);
  const index = order.findIndex((tag) => providerKey(tag) === served);
  if (!served || index <= 0) return;
  const until = at + Math.max(1, envNumber("GLM_PROVIDER_DEMOTE_MIN", 30)) * 60_000;
  for (const tag of order.slice(0, index)) {
    const key = `${model}|${providerKey(tag)}`;
    if (!demoted.has(key) || demoted.get(key) < at) console.warn(`[PROVIDER] ${tag} dilewati untuk ${model || "model ini"} (dilayani ${servedName}); diturunkan sementara`);
    demoted.set(key, until);
  }
}

// Yang sedang diturunkan dipindah ke belakang (bukan dibuang: tetap cadangan terakhir).
function applyDemotions(order, at = Date.now(), model = "") {
  if (!order) return order;
  const down = (tag) => (demoted.get(`${model}|${providerKey(tag)}`) || 0) > at;
  return [...order.filter((tag) => !down(tag)), ...order.filter(down)];
}

/**
 * Urutan provider untuk satu tier. Tidak pernah menunggu jaringan: kalau statistik
 * belum ada/basi, pakai yang terakhir (atau null) dan muat ulang di belakang.
 * @param {string} tier fast|balanced
 * @param {{ model: string, fetchEndpoints: (model) => Promise<object[]> }} source
 */
function rankedOrder(tier, { model, fetchEndpoints } = {}) {
  const cfg = pickerConfig();
  const cache = caches.get(model) || { at: 0, ranking: null };
  const stale = !cache.ranking || Date.now() - cache.at > cfg.refreshMs;
  if (stale && !inflight.has(model) && typeof fetchEndpoints === "function") {
    // Tandai dulu supaya pesan berikutnya tidak memicu muat ulang ganda.
    caches.set(model, { ...cache, at: Date.now() });
    inflight.set(model, fetchEndpoints(model)
      .then((endpoints) => {
        const ranking = rankEndpoints(endpoints, cfg, model);
        if (ranking.fast.length && ranking.balanced.length) caches.set(model, { at: Date.now(), ranking });
      })
      .catch((error) => {
        // Statistik gagal dimuat: jangan coba tiap pesan, tunggu jendela berikutnya.
        console.warn(`[PROVIDER] Statistik OpenRouter ${model} gagal dimuat:`, error.message);
      })
      .finally(() => inflight.delete(model)));
  }
  return applyDemotions(caches.get(model)?.ranking?.[tier] || null, Date.now(), model);
}

function status() {
  const now = Date.now();
  return {
    models: Object.fromEntries([...caches].map(([model, item]) => [model, { updatedAt: item.at || null, ranking: item.ranking }])),
    demoted: [...demoted].filter(([, until]) => until > now).map(([name]) => name),
  };
}

function reset() {
  caches.clear();
  inflight.clear();
  demoted.clear();
}

module.exports = { PROFILES, applyDemotions, noteServed, rankEndpoints, rankedOrder, reset, status };
