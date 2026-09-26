/**
 * Task State Machine untuk Runtime Durable (Fase 2)
 *
 * Status:
 * - queued, running, verifying, waiting_input, waiting_approval,
 *   retry_wait, delivery_uncertain, succeeded, failed, cancelled,
 *   budget_exhausted.
 *
 * Validasi transisi eksplisit:
 * - Terminal states (succeeded, failed, cancelled, budget_exhausted) TIDAK BISA dibuka ulang.
 * - Waiting states (waiting_input, waiting_approval, retry_wait) hanya dapat di-resume melalui 'queued'.
 * - Optimistic concurrency: update memerlukan expectedVersion.
 */

const { OptimisticConcurrencyError } = require("./storage");

const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  VERIFYING: "verifying",
  WAITING_INPUT: "waiting_input",
  WAITING_APPROVAL: "waiting_approval",
  RETRY_WAIT: "retry_wait",
  DELIVERY_UNCERTAIN: "delivery_uncertain",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BUDGET_EXHAUSTED: "budget_exhausted",
});

const TERMINAL_STATUSES = Object.freeze(
  new Set([
    TASK_STATUS.SUCCEEDED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.BUDGET_EXHAUSTED,
  ]),
);

const WAITING_STATUSES = Object.freeze(
  new Set([
    TASK_STATUS.WAITING_INPUT,
    TASK_STATUS.WAITING_APPROVAL,
    TASK_STATUS.RETRY_WAIT,
    TASK_STATUS.DELIVERY_UNCERTAIN,
  ]),
);

// Map transisi yang diizinkan: dari status -> set status tujuan yang sah
const ALLOWED_TRANSITIONS = Object.freeze({
  [TASK_STATUS.QUEUED]: new Set([
    TASK_STATUS.RUNNING,
    TASK_STATUS.CANCELLED,
  ]),
  [TASK_STATUS.RUNNING]: new Set([
    TASK_STATUS.VERIFYING,
    TASK_STATUS.WAITING_INPUT,
    TASK_STATUS.WAITING_APPROVAL,
    TASK_STATUS.RETRY_WAIT,
    TASK_STATUS.DELIVERY_UNCERTAIN,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.BUDGET_EXHAUSTED,
  ]),
  [TASK_STATUS.VERIFYING]: new Set([
    TASK_STATUS.SUCCEEDED,
    TASK_STATUS.RUNNING,
    TASK_STATUS.DELIVERY_UNCERTAIN,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.BUDGET_EXHAUSTED,
  ]),
  [TASK_STATUS.WAITING_INPUT]: new Set([
    TASK_STATUS.QUEUED,
    TASK_STATUS.CANCELLED,
  ]),
  [TASK_STATUS.WAITING_APPROVAL]: new Set([
    TASK_STATUS.QUEUED,
    TASK_STATUS.CANCELLED,
  ]),
  [TASK_STATUS.RETRY_WAIT]: new Set([
    TASK_STATUS.QUEUED,
    TASK_STATUS.CANCELLED,
    TASK_STATUS.FAILED,
  ]),
  [TASK_STATUS.DELIVERY_UNCERTAIN]: new Set([
    TASK_STATUS.SUCCEEDED,
    TASK_STATUS.FAILED,
    TASK_STATUS.QUEUED,
    TASK_STATUS.CANCELLED,
  ]),
  // Terminal states memiliki set kosong (tidak boleh berpindah ke mana pun)
  [TASK_STATUS.SUCCEEDED]: new Set(),
  [TASK_STATUS.FAILED]: new Set(),
  [TASK_STATUS.CANCELLED]: new Set(),
  [TASK_STATUS.BUDGET_EXHAUSTED]: new Set(),
});

class InvalidStateTransitionError extends Error {
  constructor(currentStatus, targetStatus, details = {}) {
    super(
      `Transisi status task ilegal: '${currentStatus}' -> '${targetStatus}'. ` +
        (TERMINAL_STATUSES.has(currentStatus)
          ? "Status terminal tidak dapat diubah atau dibuka ulang."
          : `Pilihan yang sah: ${[...(ALLOWED_TRANSITIONS[currentStatus] || [])].join(", ")}`),
    );
    this.name = "InvalidStateTransitionError";
    this.code = "invalid_state_transition";
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
    this.details = details;
  }
}

/**
 * Memvalidasi apakah transisi dari currentStatus ke targetStatus sah
 */
function validateTransition(currentStatus, targetStatus) {
  if (!Object.values(TASK_STATUS).includes(targetStatus)) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus, { reason: "unknown_target_status" });
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.has(targetStatus)) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus);
  }

  return true;
}

/**
 * TaskStore: Pengelola siklus hidup task di atas storage SQLite dengan validasi state machine
 */
class TaskStore {
  constructor(storage) {
    this.storage = storage;
  }

  async createTask({
    goal,
    acceptance_criteria = null,
    actor_pn,
    chat_id,
    source_event_id = null,
    scope = "active_chat",
    authorization_ref = null,
    context_epoch = 0,
    budget_snapshot = null,
    evidence_refs = [],
    risk_level = "low",
    provenance = "runtime_internal_task",
  }) {
    if (!goal || typeof goal !== "string") {
      throw new Error("goal wajib non-empty string");
    }
    if (!actor_pn || typeof actor_pn !== "string" || actor_pn.includes("@lid") || actor_pn.endsWith(".lid")) {
      throw new Error("actor_pn wajib berupa nomor telepon sah (bukan raw WhatsApp LID)");
    }
    if (!chat_id || typeof chat_id !== "string") {
      throw new Error("chat_id wajib non-empty string");
    }

    return this.storage.createTask({
      goal,
      acceptance_criteria,
      actor_pn,
      chat_id,
      source_event_id,
      scope,
      authorization_ref,
      context_epoch,
      plan_version: 1,
      status: TASK_STATUS.QUEUED,
      budget_snapshot,
      evidence_refs,
      risk_level,
      provenance,
    });
  }

  async getTask(taskId) {
    return this.storage.getTask(taskId);
  }

  async transitionTask(taskId, targetStatus, { expectedVersion, updates = {} } = {}) {
    const current = await this.storage.getTask(taskId);
    if (!current) {
      throw new Error(`Task ${taskId} tidak ditemukan`);
    }

    // Validasi transisi status
    validateTransition(current.status, targetStatus);

    return this.storage.updateTask(taskId, {
      expectedVersion: expectedVersion != null ? expectedVersion : current.version,
      status: targetStatus,
      ...updates,
    });
  }

  async resumeTask(taskId, { expectedVersion, contextEpoch = null } = {}) {
    const current = await this.storage.getTask(taskId);
    if (!current) throw new Error(`Task ${taskId} tidak ditemukan`);

    if (!WAITING_STATUSES.has(current.status)) {
      throw new Error(`Hanya status waiting (${[...WAITING_STATUSES].join(", ")}) yang dapat di-resume, status saat ini: '${current.status}'`);
    }

    const updates = {};
    if (contextEpoch != null) {
      updates.context_epoch = contextEpoch;
    }

    return this.transitionTask(taskId, TASK_STATUS.QUEUED, {
      expectedVersion: expectedVersion != null ? expectedVersion : current.version,
      updates,
    });
  }
}

module.exports = {
  TASK_STATUS,
  TERMINAL_STATUSES,
  WAITING_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidStateTransitionError,
  validateTransition,
  TaskStore,
};
