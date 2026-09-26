const { AssetStore } = require("../media/asset-store");
const { safeMediaFetch } = require("../runtime/safe-media-fetch");
const { sharedEgressLimiter } = require("../runtime/egress-limiter");

function createMediaFetchCapability({ assetStore = new AssetStore({ root: process.env.RUNTIME_ASSET_DIR }), fetcher = safeMediaFetch, limiter = sharedEgressLimiter } = {}) {
  return {
    name: "fetch_media_from_url",
    version: "1.0.0",
    description: "Unduh gambar JPEG, PNG, atau WebP dari host HTTPS yang diizinkan ke asset privat task ini.",
    risk: "medium",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "read"],
    enabled: process.env.AGENT_MEDIA_URL_ENABLED === "true",
    timeoutMs: 10000,
    sideEffect: "external",
    idempotency: "idempotent",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", minLength: 8, maxLength: 2048 } },
      required: ["url"], additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { asset_id: { type: "string" }, mime: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" }, source_url: { type: "string" } },
      required: ["asset_id", "mime", "size", "sha256", "source_url"], additionalProperties: false,
    },
    handler: async ({ url }, context = {}) => {
      if (context.engineMode === "shadow") throw new Error("media_fetch_shadow_denied");
      if (!context.originChatId || !context.taskId) throw new Error("asset_scope_required");
      const allowedHosts = String(process.env.AGENT_MEDIA_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      if (!allowedHosts.length) throw new Error("media_host_allowlist_empty");
      await limiter.reserve(context.taskId, url);
      const media = await fetcher(url, { allowedHosts, signal: context.signal });
      const stored = await assetStore.put(media.buffer, { chatId: context.originChatId, taskId: context.taskId, mime: media.mime });
      return { asset_id: stored.assetId, mime: stored.mime, size: stored.size, sha256: stored.sha256, source_url: media.sourceUrl };
    },
    verifier: async (data, context = {}) => {
      if (!context.originChatId || !context.taskId) return { ok: false, error: "asset_scope_required" };
      const asset = await assetStore.read(data.asset_id, { chatId: context.originChatId, taskId: context.taskId });
      return { ok: asset.mime === data.mime && asset.buffer.length === data.size, evidence: { asset_id: data.asset_id, sha256: data.sha256, source_url: data.source_url } };
    },
  };
}

module.exports = { createMediaFetchCapability };
