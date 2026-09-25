/**
 * Durable Inbox & Deduplication untuk Runtime Durable (Fase 2)
 *
 * Mengelola deduplikasi pesan masuk berdasarkan:
 * - transport (mis. "baileys")
 * - chat_id
 * - participant_pn (PN murni; raw LID ditolak)
 * - source_event_id (message ID dari transport)
 *
 * Menjamin insert event dan enqueue task dilakukan dalam transaksi tunggal.
 * Duplikasi event tidak membuat task, job, atau outbox baru.
 */

class EpochStaleError extends Error {
  constructor(currentEpoch, storedEpoch, details = {}) {
    super(
      `Context epoch tidak valid: epoch pemanggil ${currentEpoch} lebih lama dari epoch aktif ${storedEpoch}. Efek samping dibatalkan.`,
    );
    this.name = "EpochStaleError";
    this.code = "epoch_stale";
    this.currentEpoch = currentEpoch;
    this.storedEpoch = storedEpoch;
    this.details = details;
  }
}

class InboxManager {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Mendapatkan epoch saat ini untuk chat. Satu source of truth melalui storage.
   */
  getChatEpoch(chatId) {
    if (this.storage && typeof this.storage.getChatEpoch === "function") {
      return this.storage.getChatEpoch(chatId);
    }
    return 0;
  }

  /**
   * Mendapatkan epoch terbaru dari database secara asynchronous.
   */
  async getChatEpochAsync(chatId) {
    if (this.storage && typeof this.storage.getChatEpochAsync === "function") {
      return this.storage.getChatEpochAsync(chatId);
    }
    return this.getChatEpoch(chatId);
  }

  /**
   * Menaikkan context epoch saat chat di-clear, di-reset, atau di-cancel.
   * Transaksional: menaikkan epoch di SQLite dan membatalkan task & outbox aktif.
   */
  bumpChatEpoch(chatId, options) {
    if (this.storage && typeof this.storage.bumpChatEpoch === "function") {
      return this.storage.bumpChatEpoch(chatId, options);
    }
    return 1;
  }

  /**
   * Memvalidasi apakah context epoch masih valid sebelum menulis efek samping.
   */
  verifyEpoch(chatId, callerEpoch) {
    const activeEpoch = this.getChatEpoch(chatId);
    if (Number(callerEpoch) < activeEpoch) {
      throw new EpochStaleError(callerEpoch, activeEpoch, { chatId });
    }
    return true;
  }

  /**
   * Memproses event masuk secara atomik & tahan duplikasi.
   */
  async processInboundEvent({
    transport = "baileys",
    chatId,
    participantPn,
    sourceEventId,
    payload = {},
    taskIntent = null,
  }) {
    if (!chatId || typeof chatId !== "string") {
      throw new Error("chatId wajib non-empty string");
    }
    if (!participantPn || typeof participantPn !== "string") {
      throw new Error("participantPn wajib non-empty string");
    }
    // Fail-closed untuk raw WhatsApp LID
    if (participantPn.includes("@lid") || participantPn.endsWith(".lid")) {
      throw new Error("Raw WhatsApp LID ditolak sebagai participant_pn identity");
    }
    if (!sourceEventId || typeof sourceEventId !== "string") {
      throw new Error("sourceEventId wajib non-empty string");
    }

    const contextEpoch = this.getChatEpoch(chatId);

    const eventData = {
      transport,
      chat_id: chatId,
      participant_pn: participantPn,
      source_event_id: sourceEventId,
      payload_redacted: payload,
      context_epoch: contextEpoch,
    };

    let taskData = null;
    if (taskIntent) {
      taskData = {
        goal: taskIntent.goal,
        acceptance_criteria: taskIntent.acceptance_criteria || null,
        scope: taskIntent.scope || "active_chat",
        authorization_ref: taskIntent.authorization_ref || null,
        context_epoch: contextEpoch,
        status: "queued",
        budget_snapshot: taskIntent.budget_snapshot || null,
        evidence_refs: taskIntent.evidence_refs || [],
        risk_level: taskIntent.risk_level || taskIntent.risk || "low",
        provenance: taskIntent.provenance || "runtime_inbound_message",
      };
    }

    // Insert atomic via storage transaction
    const result = await this.storage.insertEventAndEnqueueTask({
      event: eventData,
      task: taskData,
    });

    return {
      duplicate: result.duplicate,
      eventId: result.eventId,
      task: result.task,
      contextEpoch,
    };
  }
}

module.exports = {
  InboxManager,
  EpochStaleError,
};
