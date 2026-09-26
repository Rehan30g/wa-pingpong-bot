const { AssetStore } = require("../media/asset-store");

function createMessageMediaCapability({ assetStore = new AssetStore({ root: process.env.RUNTIME_ASSET_DIR }) } = {}) {
  return {
    name: "fetch_media_from_message",
    version: "1.0.0",
    description: "Baca asset gambar yang dilampirkan pada pesan sumber task di chat aktif.",
    risk: "low",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "read"],
    enabled: process.env.AGENT_MESSAGE_MEDIA_ENABLED === "true",
    timeoutMs: 10000,
    sideEffect: "read",
    idempotency: "read_only",
    inputSchema: {
      type: "object",
      properties: { entry_id: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["entry_id"], additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { asset_id: { type: "string" }, mime: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" } },
      required: ["asset_id", "mime", "size", "sha256"], additionalProperties: false,
    },
    handler: async ({ entry_id }, context = {}) => {
      if (!context.originChatId || !context.taskId || !context.storage) throw new Error("media_scope_required");
      const task = await context.storage.getTask(context.taskId);
      if (!task || task.chat_id !== context.originChatId || task.source_event_id !== entry_id) throw new Error("media_source_denied");
      const source = (task.evidence_refs || []).find((item) => item?.type === "source_media" && item.entry_id === entry_id);
      if (!source?.asset_id) throw new Error("media_source_missing");
      const asset = await assetStore.read(source.asset_id, { chatId: context.originChatId, taskId: context.taskId });
      return { asset_id: source.asset_id, mime: asset.mime, size: asset.buffer.length, sha256: source.sha256 };
    },
    verifier: async (data, context = {}) => {
      if (!context.originChatId || !context.taskId || !data?.asset_id) return { ok: false, error: "media_scope_required" };
      const asset = await assetStore.read(data.asset_id, { chatId: context.originChatId, taskId: context.taskId });
      return { ok: asset.mime === data.mime && asset.buffer.length === data.size, evidence: { asset_id: data.asset_id, sha256: data.sha256 } };
    },
  };
}

module.exports = { createMessageMediaCapability };
