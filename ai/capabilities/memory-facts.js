function isSafeFact(text) {
  const value = String(text || "").trim();
  return Boolean(value && value.length <= 500 && !/sk-or-v1-|(?:api[_ -]?key|token|password|secret)\s*[:=]/i.test(value));
}

function createMemorySearchCapability({ storage }) {
  return {
    name: "memory_search", version: "1.0.0", description: "Cari fakta yang bersumber hanya dalam chat tugas ini.",
    risk: "low", channelScopes: ["group", "dm"], requiredScopes: ["active_chat", "read"],
    enabled: process.env.AGENT_MEMORY_FACTS_ENABLED === "true", timeoutMs: 5000, sideEffect: "read", idempotency: "read_only",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { facts: { type: "array", items: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" }, source_entry_id: { type: "string" }, confidence: { type: "number" }, status: { type: "string", enum: ["active", "conflicted"] } }, required: ["memory_id", "text", "source_entry_id", "confidence", "status"], additionalProperties: false } } }, required: ["facts"], additionalProperties: false },
    handler: async ({ query }, context = {}) => {
      if (!context.originChatId || !/^\d{9,15}$/.test(String(context.actor?.id || ""))) throw new Error("memory_search_scope_required");
      const rows = await storage.searchMemoryFacts({ chatId: context.originChatId, actorPn: context.actor.id, query, limit: 5 });
      return { facts: rows.map((row) => ({ memory_id: row.memory_id, text: row.fact_text, source_entry_id: row.source_entry_id, confidence: Number(row.confidence), status: row.status })) };
    },
    verifier: async (result, context = {}) => {
      if (!context.originChatId || !Array.isArray(result?.facts)) return { ok: false, evidence: {} };
      for (const item of result.facts) {
        const fact = await storage.getMemoryFact(item.memory_id, context.originChatId);
        if (!fact || fact.source_entry_id !== item.source_entry_id || fact.fact_text !== item.text || fact.status !== item.status) return { ok: false, evidence: {} };
      }
      return { ok: true, evidence: { source_entry_ids: result.facts.map((fact) => fact.source_entry_id) } };
    },
  };
}

function createMemoryRememberCapability({ storage }) {
  return {
    name: "memory_remember", version: "1.0.0", description: "Simpan fakta yang diminta eksplisit oleh pengguna dari pesan sumber tugas ini, persis seperti teks permintaan.",
    risk: "low", channelScopes: ["group", "dm"], requiredScopes: ["active_chat", "write"],
    enabled: process.env.AGENT_MEMORY_FACTS_ENABLED === "true", timeoutMs: 5000, sideEffect: "write", idempotency: "idempotent",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { memory_id: { type: "string" }, source_entry_id: { type: "string" }, chat_id: { type: "string" } }, required: ["memory_id", "source_entry_id", "chat_id"], additionalProperties: false },
    handler: async (_input, context = {}) => {
      if (!context.taskId || !context.originChatId) throw new Error("memory_task_scope_required");
      const task = await storage.getTask(context.taskId);
      if (!task || task.chat_id !== context.originChatId || !task.source_event_id || task.actor_pn !== context.actor?.id) throw new Error("memory_source_denied");
      const match = /^Ingat fakta: ([\s\S]+)$/.exec(String(task.goal || ""));
      if (!match || !isSafeFact(match[1])) throw new Error("memory_fact_invalid");
      const fact = await storage.recordMemoryFact({ chatId: task.chat_id, subjectPn: task.actor_pn, sourceEntryId: task.source_event_id, text: match[1], confidence: 1, contextEpoch: task.context_epoch });
      return { memory_id: fact.memory_id, source_entry_id: fact.source_entry_id, chat_id: fact.source_chat_id };
    },
    verifier: async (result, context = {}) => {
      const fact = await storage.getMemoryFact(result?.memory_id, context.originChatId);
      return { ok: Boolean(fact && fact.source_entry_id === result.source_entry_id && fact.source_chat_id === result.chat_id), evidence: { memory_id: result?.memory_id, source_entry_id: result?.source_entry_id } };
    },
  };
}

function createMemoryCorrectCapability({ storage }) {
  return {
    name: "memory_correct", version: "1.0.0", description: "Koreksi fakta milik actor dalam chat sumber dengan pesan koreksi eksplisit.",
    risk: "low", channelScopes: ["group", "dm"], requiredScopes: ["active_chat", "write"],
    enabled: process.env.AGENT_MEMORY_FACTS_ENABLED === "true", timeoutMs: 5000, sideEffect: "write", idempotency: "idempotent",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { memory_id: { type: "string" }, corrected_memory_id: { type: "string" }, source_entry_id: { type: "string" }, version: { type: "integer" } }, required: ["memory_id", "corrected_memory_id", "source_entry_id", "version"], additionalProperties: false },
    handler: async (_input, context = {}) => {
      if (!context.taskId || !context.originChatId) throw new Error("memory_task_scope_required");
      const task = await storage.getTask(context.taskId);
      if (!task || task.chat_id !== context.originChatId || !task.source_event_id || task.actor_pn !== context.actor?.id) throw new Error("memory_source_denied");
      const match = /^Koreksi fakta (mem_[a-f0-9]{32}): ([\s\S]+)$/.exec(String(task.goal || ""));
      if (!match || !isSafeFact(match[2])) throw new Error("memory_correction_invalid");
      const fact = await storage.correctMemoryFact({ memoryId: match[1], chatId: task.chat_id, subjectPn: task.actor_pn, sourceEntryId: task.source_event_id, text: match[2], contextEpoch: task.context_epoch });
      return { memory_id: fact.memory_id, corrected_memory_id: match[1], source_entry_id: fact.source_entry_id, version: Number(fact.version) };
    },
    verifier: async (result, context = {}) => {
      const fact = await storage.getMemoryFact(result?.memory_id, context.originChatId);
      return { ok: Boolean(fact && fact.conflict_key === result.corrected_memory_id && fact.source_entry_id === result.source_entry_id && Number(fact.version) === result.version), evidence: { memory_id: result?.memory_id, source_entry_id: result?.source_entry_id } };
    },
  };
}

module.exports = { isSafeFact, createMemorySearchCapability, createMemoryRememberCapability, createMemoryCorrectCapability };
