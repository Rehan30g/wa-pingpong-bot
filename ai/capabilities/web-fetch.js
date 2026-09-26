const { safeWebFetch } = require("../runtime/safe-web-fetch");
const { sharedEgressLimiter } = require("../runtime/egress-limiter");

function createWebFetchCapability({ fetcher = safeWebFetch, limiter = sharedEgressLimiter } = {}) {
  return {
    name: "web_fetch",
    version: "1.0.0",
    description: "Membaca teks halaman HTTPS dari domain yang diizinkan owner.",
    risk: "medium",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "read"],
    enabled: process.env.AGENT_WEB_FETCH_ENABLED === "true",
    timeoutMs: 8000,
    sideEffect: "external",
    idempotency: "idempotent",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", minLength: 12, maxLength: 2048 } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { url: { type: "string" }, text: { type: "string" }, fetchedAt: { type: "string" } },
      required: ["url", "text", "fetchedAt"],
      additionalProperties: false,
    },
    handler: async ({ url }, context = {}) => {
      if (context.engineMode === "shadow" || process.env.RUNTIME_ENGINE_MODE === "shadow") throw new Error("web_disabled_in_shadow");
      const allowedHosts = String(process.env.AGENT_WEB_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!allowedHosts.length) throw new Error("web_allowlist_empty");
      await limiter.reserve(context.taskId, url);
      return fetcher(url, { allowedHosts, signal: context.signal });
    },
    verifier: async (result) => ({ ok: Boolean(result?.url && result?.fetchedAt && typeof result?.text === "string" && result.text.trim()), evidence: { url: result?.url, fetchedAt: result?.fetchedAt, bytes: result?.text?.length || 0 } }),
  };
}

module.exports = { createWebFetchCapability };
