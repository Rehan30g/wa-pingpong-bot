/**
 * Capability Minimal Deterministik untuk Task MVP (Fase 3)
 *
 * Sesuai kontrak Plan.md & Registry Fase 1:
 * - create_note: Menyimpan catatan berversi terisolasi pada chat asal.
 * - read_note: Membaca catatan dengan penegakan batasan chat asal (cross-chat isolation).
 * - summarize_context: Peringkas deterministik berbasis poin teks.
 * - export_archive: Capability berisiko tinggi untuk pengujian persetujuan (approval).
 *
 * Invarian:
 * - Tidak mengaktifkan filesystem, shell, web crawling, broad messaging, forwarding,
 *   atau send WhatsApp bebas pada Fase 3.
 */

const crypto = require("node:crypto");

function createMvpCapabilities({ storage = null } = {}) {
  // In-memory fallback untuk context tanpa storage DB (mis. unit tests terisolasi)
  const memoryNotes = new Map();

  const createNoteCap = {
    name: "create_note",
    version: "1.0.0",
    description: "Membuat catatan teks baru yang tersimpan secara durable dalam obrolan aktif.",
    risk: "low",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "write"],
    enabled: true,
    timeoutMs: 10_000,
    sideEffect: "write",
    idempotency: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 100 },
        content: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        title: { type: "string" },
        size: { type: "integer" },
        created_at: { type: "string" },
      },
      required: ["note_id", "title", "size", "created_at"],
      additionalProperties: false,
    },
    handler: async (input, context = {}) => {
      const activeStorage = context.storage || storage;
      const originChatId = context.originChatId || "default_chat";
      const ownerPn = context.actor?.id || "system";
      const now = new Date().toISOString();

      if (activeStorage && typeof activeStorage.createNote === "function") {
        const record = await activeStorage.createNote({
          chatId: originChatId,
          ownerPn,
          title: input.title,
          content: input.content,
        });
        return {
          note_id: record.note_id,
          title: record.title,
          size: record.content ? record.content.length : 0,
          created_at: record.created_at || now,
        };
      }

      // In-memory fallback
      const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const noteObj = {
        note_id: noteId,
        chat_id: originChatId,
        owner_pn: ownerPn,
        title: input.title,
        content: input.content,
        created_at: now,
      };
      memoryNotes.set(noteId, noteObj);
      return {
        note_id: noteId,
        title: input.title,
        size: input.content.length,
        created_at: now,
      };
    },
    verifier: async (data, context = {}) => {
      const activeStorage = context.storage || storage;
      if (!data || !data.note_id) {
        return { ok: false, error: "Note ID tidak ditemukan pada hasil" };
      }
      if (activeStorage && typeof activeStorage.getNote === "function") {
        const verified = await activeStorage.getNote(data.note_id);
        if (!verified) {
          return { ok: false, error: "Catatan tidak ditemukan di penyimpanan transaksional" };
        }
      }
      return {
        ok: true,
        evidence: {
          note_id: data.note_id,
          title: data.title,
          size: data.size,
          verified: true,
        },
      };
    },
  };

  const readNoteCap = {
    name: "read_note",
    version: "1.0.0",
    description: "Membaca kembali catatan teks yang sebelumnya disimpan di obrolan aktif.",
    risk: "low",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "read"],
    enabled: true,
    timeoutMs: 10_000,
    sideEffect: "read",
    idempotency: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["note_id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["note_id", "title", "content"],
      additionalProperties: false,
    },
    handler: async (input, context = {}) => {
      const activeStorage = context.storage || storage;
      const originChatId = context.originChatId;
      if (!originChatId) throw new Error("active_chat_required");

      let note = null;
      if (activeStorage && typeof activeStorage.getNote === "function") {
        note = await activeStorage.getNote(input.note_id);
      } else {
        note = memoryNotes.get(input.note_id) || null;
      }

      if (!note) {
        throw new Error(`Note '${input.note_id}' tidak ditemukan`);
      }

      // Penegakan batas chat asal (cross-chat isolation)
      if (!note.chat_id || note.chat_id !== originChatId) {
        throw new Error(`Akses ditolak: note '${input.note_id}' berasal dari obrolan lain (${note.chat_id})`);
      }

      return {
        note_id: note.note_id,
        title: note.title,
        content: note.content,
      };
    },
    verifier: async (data, context = {}) => {
      if (!data || !data.note_id) {
        return { ok: false, error: "Note ID hilang pada pembacaan" };
      }
      return {
        ok: true,
        evidence: {
          note_id: data.note_id,
          title: data.title,
          content_length: (data.content || "").length,
          verified: true,
        },
      };
    },
  };

  const summarizeContextCap = {
    name: "summarize_context",
    version: "1.0.0",
    description: "Meringkas teks panjang menjadi poin-poin terstruktur secara deterministik.",
    risk: "low",
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "read"],
    enabled: true,
    timeoutMs: 10_000,
    sideEffect: "none",
    idempotency: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 5000 },
        max_points: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        point_count: { type: "integer" },
      },
      required: ["summary", "point_count"],
      additionalProperties: false,
    },
    handler: async (input, context = {}) => {
      const maxPoints = Number.isInteger(input.max_points) ? input.max_points : 3;
      const rawText = String(input.text || "").trim();

      // Ekstraksi kalimat/poin deterministik
      const sentences = rawText
        .split(/(?:\r?\n|[.!?]+)/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 5);

      const selected = sentences.slice(0, maxPoints);
      const summary = selected.length > 0
        ? selected.map((s, idx) => `${idx + 1}. ${s}`).join("\n")
        : `1. ${rawText.slice(0, 100)}`;

      return {
        summary,
        point_count: selected.length || 1,
      };
    },
    verifier: async (data) => {
      if (!data || typeof data.summary !== "string" || data.summary.trim().length === 0) {
        return { ok: false, error: "Ringkasan kosong" };
      }
      return {
        ok: true,
        evidence: {
          point_count: data.point_count,
          summary_chars: data.summary.length,
          verified: true,
        },
      };
    },
  };

  const exportArchiveCap = {
    name: "export_archive",
    version: "1.0.0",
    description: "Reservasi nama capability arsip; belum tersedia sampai ekspor data dan verifikasi arsip diimplementasikan.",
    risk: "high",
    requiresApproval: true,
    channelScopes: ["group", "dm"],
    requiredScopes: ["active_chat", "write"],
    enabled: false,
    timeoutMs: 10_000,
    sideEffect: "write",
    idempotency: "idempotent",
    inputSchema: {
      type: "object",
      properties: {
        archive_name: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["archive_name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        archive_id: { type: "string" },
        name: { type: "string" },
        status: { type: "string" },
      },
      required: ["archive_id", "name", "status"],
      additionalProperties: false,
    },
    handler: async () => {
      throw new Error("archive_not_implemented");
    },
    verifier: async (data) => {
      if (!data || !data.archive_id) {
        return { ok: false, error: "Archive ID hilang" };
      }
      return {
        ok: true,
        evidence: {
          archive_id: data.archive_id,
          name: data.name,
          status: data.status,
          verified: true,
        },
      };
    },
  };

  return {
    createNote: createNoteCap,
    readNote: readNoteCap,
    summarizeContext: summarizeContextCap,
    exportArchive: exportArchiveCap,
  };
}

/**
 * Mendaftarkan seluruh capability MVP ke instance registry yang diberikan
 */
function registerMvpCapabilities(registry, options = {}) {
  const caps = createMvpCapabilities(options);
  for (const cap of Object.values(caps)) {
    registry.registerCapability(cap);
  }
  return registry;
}

module.exports = {
  createMvpCapabilities,
  registerMvpCapabilities,
};
