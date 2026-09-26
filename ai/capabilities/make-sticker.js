const { AssetStore } = require("../media/asset-store");
const { convertSticker } = require("../media/sticker-converter");

function createMakeStickerCapability({ assetStore = new AssetStore({ root: process.env.RUNTIME_ASSET_DIR }), converter = convertSticker } = {}) {
  return {
    name: "make_sticker",
    version: "1.0.0",
    description: "Ubah asset gambar milik task ini menjadi stiker WebP 512x512.",
    risk: "medium",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "write"],
    enabled: process.env.AGENT_MAKE_STICKER_ENABLED === "true",
    timeoutMs: 8000,
    sideEffect: "write",
    idempotency: "idempotent",
    inputSchema: {
      type: "object",
      properties: { asset_id: { type: "string", minLength: 1, maxLength: 80 } },
      required: ["asset_id"], additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { asset_id: { type: "string" }, mime: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" } },
      required: ["asset_id", "mime", "size", "sha256"], additionalProperties: false,
    },
    handler: async ({ asset_id }, context = {}) => {
      if (!context.originChatId || !context.taskId) throw new Error("sticker_scope_required");
      const source = await assetStore.read(asset_id, { chatId: context.originChatId, taskId: context.taskId });
      if (!["image/jpeg", "image/png", "image/webp"].includes(source.mime)) throw new Error("sticker_source_mime_invalid");
      const webp = await converter(source.buffer);
      const saved = await assetStore.put(webp, { chatId: context.originChatId, taskId: context.taskId, mime: "image/webp" });
      return { asset_id: saved.assetId, mime: saved.mime, size: saved.size, sha256: saved.sha256 };
    },
    verifier: async (data, context = {}) => {
      if (!data?.asset_id || !context.originChatId || !context.taskId) return { ok: false, error: "sticker_scope_required" };
      const asset = await assetStore.read(data.asset_id, { chatId: context.originChatId, taskId: context.taskId });
      const valid = asset.mime === "image/webp" && asset.buffer.length <= 512 * 1024 && asset.buffer.toString("ascii", 0, 4) === "RIFF" && asset.buffer.toString("ascii", 8, 12) === "WEBP";
      return { ok: valid, evidence: { asset_id: data.asset_id, sha256: data.sha256, size: data.size } };
    },
  };
}

module.exports = { createMakeStickerCapability };
