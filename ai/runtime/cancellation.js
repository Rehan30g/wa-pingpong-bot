/**
 * Cancellation, Epoch, and Idempotency Manager untuk Runtime Durable (Fase 2)
 *
 * Menjamin:
 * 1. Cancel/clear/reset/pause menaikkan context epoch sehingga write/outbox lama ditolak sebelum efek samping.
 * 2. Idempotency records mencegah operasi logis yang sama dieksekusi dua kali.
 * 3. Idempotency key task + capability + step harus exact sesuai helper Fase 1.
 * 4. Persetujuan (Approval) terikat pada actor PN, task, capability/operation, hash args, expiry, dan single-use.
 * 5. Perubahan argumen sekecil apa pun membatalkan persetujuan yang ada.
 */

const crypto = require("node:crypto");
const { buildIdempotencyKey, verifyIdempotencyKey } = require("../capabilities/registry");

function computeArgsHash(args) {
  if (args === undefined || args === null) return "none";
  // Serialisasi canonical JSON dengan sorting key untuk hash deterministik
  function canonicalStringify(obj) {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map(canonicalStringify).join(",")}]`;
    }
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
  }

  const canonical = canonicalStringify(args);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

class ApprovalError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ApprovalError";
    this.code = "approval_rejected";
    this.details = details;
  }
}

class CancellationManager {
  constructor(storage) {
    this.storage = storage;
  }

  getEpoch(chatId) {
    if (this.storage && typeof this.storage.getChatEpoch === "function") {
      return this.storage.getChatEpoch(chatId);
    }
    return 0;
  }

  async getEpochAsync(chatId) {
    if (this.storage && typeof this.storage.getChatEpochAsync === "function") {
      return this.storage.getChatEpochAsync(chatId);
    }
    return this.getEpoch(chatId);
  }

  bumpEpoch(chatId, options) {
    if (this.storage && typeof this.storage.bumpChatEpoch === "function") {
      return this.storage.bumpChatEpoch(chatId, options);
    }
    return 1;
  }

  verifyEpoch(chatId, candidateEpoch) {
    const current = this.getEpoch(chatId);
    if (Number(candidateEpoch) < current) {
      throw new Error(`Context epoch kadaluwarsa (${candidateEpoch} < ${current}). Efek samping dibatalkan.`);
    }
    return true;
  }

  // ==========================================
  // IDEMPOTENCY
  // ==========================================

  buildKey({ taskId, capabilityName, logicalOperationId }) {
    return buildIdempotencyKey({ taskId, capabilityName, logicalOperationId });
  }

  async checkIdempotency(key) {
    const record = await this.storage.getIdempotencyRecord(key);
    if (record) {
      return {
        alreadyExecuted: true,
        result: record.result_redacted,
      };
    }
    return { alreadyExecuted: false };
  }

  async recordIdempotency(key, { taskId, capabilityName, logicalOperationId, result }) {
    await this.storage.saveIdempotencyRecord(key, {
      taskId,
      capabilityName,
      logicalOperationId,
      resultRedacted: result,
    });
  }

  // ==========================================
  // APPROVALS
  // ==========================================

  async grantApproval({
    taskId,
    actorPn,
    capabilityName,
    logicalOperationId,
    args = {},
    scope = "active_chat",
    expiresInMs = 300_000, // 5 menit default
  }) {
    if (!actorPn || actorPn.includes("@lid")) {
      throw new Error("actorPn wajib berupa nomor telepon sah (bukan raw WhatsApp LID)");
    }

    const argsHash = computeArgsHash(args);
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    return this.storage.createApproval({
      task_id: taskId,
      actor_pn: actorPn,
      capability_name: capabilityName,
      logical_operation_id: logicalOperationId,
      args_hash: argsHash,
      scope,
      status: "approved",
      expires_at: expiresAt,
    });
  }

  async verifyAndConsumeApproval({
    taskId,
    actorPn,
    capabilityName,
    logicalOperationId,
    args = {},
  }) {
    const argsHash = computeArgsHash(args);
    const nowIso = new Date().toISOString();

    const approval = await this.storage.findValidApproval({
      taskId,
      actorPn,
      capabilityName,
      logicalOperationId,
      argsHash,
      nowIso,
    });

    if (!approval) {
      throw new ApprovalError(
        `Persetujuan tidak ditemukan, argumen berubah, atau sudah kedaluwarsa untuk task ${taskId} / capability ${capabilityName}`,
        { taskId, actorPn, capabilityName, logicalOperationId, argsHash },
      );
    }

    // Single-use enforcement: tandai 'used'
    const consumed = await this.storage.useApproval(approval.approval_id);
    if (!consumed) {
      throw new ApprovalError(
        `Persetujuan ${approval.approval_id} telah digunakan sebelumnya (single-use constraint)`,
        { approvalId: approval.approval_id },
      );
    }

    return approval;
  }
}

module.exports = {
  computeArgsHash,
  CancellationManager,
  ApprovalError,
};
