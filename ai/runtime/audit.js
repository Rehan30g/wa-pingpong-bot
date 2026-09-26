/**
 * Audit Persistence Manager untuk Runtime Durable (Fase 2)
 *
 * Merekam jejak audit append-only ke tabel audit_events di SQLite.
 * Semua payload melewati redaction Fase 1 (API key, token, media data URL disensor).
 */

const { redactObject } = require("../observability/redact");

class AuditManager {
  constructor(storage) {
    this.storage = storage;
  }

  async recordEvent({
    eventType,
    taskId = null,
    jobId = null,
    actorPn = null,
    details = {},
  }) {
    if (!eventType || typeof eventType !== "string") {
      throw new Error("eventType wajib non-empty string");
    }

    const sanitizedDetails = redactObject(details);

    return this.storage.recordAuditEvent({
      eventType,
      taskId,
      jobId,
      actorPn,
      details: sanitizedDetails,
    });
  }

  async getEvents({ taskId = null, jobId = null, limit = 50 } = {}) {
    return this.storage.listAuditEvents({ taskId, jobId, limit });
  }
}

module.exports = {
  AuditManager,
};
