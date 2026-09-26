/**
 * Durable Budget untuk Runtime Durable (Fase 2)
 *
 * Memperluas TaskBudget dengan persistensi ledger ke tabel budget_ledger di SQLite:
 * - Setiap reservasi dan rekonsiliasi dicatat sebagai transaksi append-only.
 * - Recovery/restart memulihkan snapshot anggaran dari database, TIDAK PERNAH mereset budget.
 * - Nilai token dan biaya yang hilang memakai akuntansi konservatif dari Fase 1.
 */

const { TaskBudget, BudgetExhaustedError, DEFAULT_LIMITS, CONSERVATIVE_ESTIMATES } = require("./budget");

class DurableBudget {
  constructor(taskId, storage, customLimits = {}) {
    this.taskId = taskId;
    this.storage = storage;
    this.budget = new TaskBudget(customLimits);
  }

  /**
   * Menginisialisasi budget dengan memuat snapshot terakhir dari database jika ada (recovery)
   */
  async init() {
    const latestSnapshot = await this.storage.getLatestBudgetSnapshot(this.taskId);
    if (latestSnapshot && latestSnapshot.usage) {
      // Pulihkan akumulasi penggunaan agar tidak reset saat restart
      this.budget.usage = { ...latestSnapshot.usage };
      if (latestSnapshot.limits) {
        this.budget.limits = { ...this.budget.limits, ...latestSnapshot.limits };
      }
    }
    return this;
  }

  checkBudget(type = null) {
    return this.budget.checkBudget(type);
  }

  async reserve({ type = "model", estimatedTokens, estimatedCost } = {}) {
    const prevSnapshot = this.budget.getSnapshot();
    const resId = this.budget.reserve({ type, estimatedTokens, estimatedCost });
    const newSnapshot = this.budget.getSnapshot();

    await this.storage.recordBudgetEntry({
      task_id: this.taskId,
      type: "reservation",
      tool_steps_delta: 0,
      model_calls_delta: 0,
      retries_delta: 0,
      tokens_delta: newSnapshot.reserved.tokens - prevSnapshot.reserved.tokens,
      cost_usd_delta: Number((newSnapshot.reserved.costUsd - prevSnapshot.reserved.costUsd).toFixed(6)),
      snapshot: newSnapshot,
    });

    return resId;
  }

  async reconcile(reservationId, { actualTokens, actualCost, retried = false } = {}) {
    const prevSnapshot = this.budget.getSnapshot();
    this.budget.reconcile(reservationId, { actualTokens, actualCost, retried });
    const newSnapshot = this.budget.getSnapshot();

    await this.storage.recordBudgetEntry({
      task_id: this.taskId,
      type: "reconciliation",
      tool_steps_delta: newSnapshot.usage.toolSteps - prevSnapshot.usage.toolSteps,
      model_calls_delta: newSnapshot.usage.modelCalls - prevSnapshot.usage.modelCalls,
      retries_delta: newSnapshot.usage.retries - prevSnapshot.usage.retries,
      tokens_delta: newSnapshot.usage.tokensUsed - prevSnapshot.usage.tokensUsed,
      cost_usd_delta: Number((newSnapshot.usage.costUsd - prevSnapshot.usage.costUsd).toFixed(6)),
      snapshot: newSnapshot,
    });
  }

  async reconcileToolAttempt(reservationId) {
    const prevSnapshot = this.budget.getSnapshot();
    this.budget.reconcileToolAttempt(reservationId);
    const newSnapshot = this.budget.getSnapshot();

    await this.storage.recordBudgetEntry({
      task_id: this.taskId,
      type: "tool_attempt",
      tool_steps_delta: 1,
      model_calls_delta: 0,
      retries_delta: 0,
      tokens_delta: 0,
      cost_usd_delta: 0.0,
      snapshot: newSnapshot,
    });
  }

  async release(reservationId) {
    this.budget.release(reservationId);
  }

  async recordRetry() {
    const prevRetries = this.budget.usage.retries;
    const count = this.budget.recordRetry();
    const newSnapshot = this.budget.getSnapshot();

    await this.storage.recordBudgetEntry({
      task_id: this.taskId,
      type: "retry",
      tool_steps_delta: 0,
      model_calls_delta: 0,
      retries_delta: count - prevRetries,
      tokens_delta: 0,
      cost_usd_delta: 0.0,
      snapshot: newSnapshot,
    });

    return count;
  }

  getSnapshot() {
    return this.budget.getSnapshot();
  }
}

module.exports = {
  DurableBudget,
  BudgetExhaustedError,
  DEFAULT_LIMITS,
  CONSERVATIVE_ESTIMATES,
};
