const { AssetStore } = require("../media/asset-store");

function createSendAssetCapability({ assetStore = new AssetStore({ root: process.env.RUNTIME_ASSET_DIR }) } = {}) {
  return {
    name: "send_asset",
    version: "1.0.0",
    description: "Antrekan asset gambar atau stiker milik task untuk dikirim ke chat asal setelah verifikasi.",
    risk: "medium",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "send"],
    enabled: process.env.AGENT_SEND_ASSET_ENABLED === "true",
    timeoutMs: 10000,
    sideEffect: "send",
    idempotency: "transactional",
    inputSchema: {
      type: "object",
      properties: { asset_id: { type: "string", minLength: 1, maxLength: 80 }, mode: { type: "string", enum: ["image", "sticker"] } },
      required: ["asset_id", "mode"], additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { asset_id: { type: "string" }, mime: { type: "string" }, size: { type: "integer" }, mode: { type: "string", enum: ["image", "sticker"] } },
      required: ["asset_id", "mime", "size", "mode"], additionalProperties: false,
    },
    handler: async ({ asset_id, mode }, context = {}) => {
      if (!context.originChatId || !context.taskId) throw new Error("asset_send_scope_required");
      const asset = await assetStore.read(asset_id, { chatId: context.originChatId, taskId: context.taskId });
      if (mode === "sticker" && asset.mime !== "image/webp") throw new Error("asset_sticker_mime_invalid");
      if (mode === "image" && !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)) throw new Error("asset_image_mime_invalid");
      return { asset_id, mime: asset.mime, size: asset.buffer.length, mode };
    },
    verifier: async (data, context = {}) => {
      if (!data?.asset_id || !context.originChatId || !context.taskId) return { ok: false, error: "asset_send_scope_required" };
      const asset = await assetStore.read(data.asset_id, { chatId: context.originChatId, taskId: context.taskId });
      return { ok: asset.mime === data.mime && asset.buffer.length === data.size, evidence: { asset_id: data.asset_id, mode: data.mode, status: "pending_delivery" } };
    },
  };
}

module.exports = { createSendAssetCapability };
