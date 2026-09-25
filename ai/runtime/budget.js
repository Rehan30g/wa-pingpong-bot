class BudgetExhaustedError extends Error {
  constructor(reason, details = {}) {
    super(`Anggaran runtime habis: ${reason}`);
    this.name = "BudgetExhaustedError";
    this.code = "budget_exhausted";
    this.reason = reason;
    this.details = details;
  }
}

// Batas default terkonfigurasi sesuai Plan.md
const DEFAULT_LIMITS = Object.freeze({
  maxToolSteps: 8,
  maxModelCalls: 12,
  maxRetries: 2,          // Maksimal tepat 2 percobaan ulang
  maxWallTimeMs: 180_000, // 3 menit (180 detik)
  maxTokens: 16_000,      // Default terkonfigurasi untuk tugas terkelola (bukan standar universal)
  maxCostUsd: 0.05,
});

const CONSERVATIVE_ESTIMATES = Object.freeze({
  promptTokens: 500,
  completionTokens: 200,
  totalTokens: 700,
  costUsd: 0.000175,
});

class TaskBudget {
  constructor(customLimits = {}) {
    this.limits = {
      ...DEFAULT_LIMITS,
      ...customLimits,
    };

    this.usage = {
      toolSteps: 0,
      modelCalls: 0,
      retries: 0,
      tokensUsed: 0,
      costUsd: 0,
    };

    this.reserved = {
      toolSteps: 0,
      modelCalls: 0,
      tokens: 0,
      costUsd: 0,
    };

    this.startTime = Date.now();
    this.reservationCounter = 0;
    this.activeReservations = new Map();
  }

  isWallTimeExceeded() {
    return Date.now() - this.startTime > this.limits.maxWallTimeMs;
  }

  checkBudget(type = null) {
    if (this.isWallTimeExceeded()) {
      return {
        ok: false,
        reason: "wall_time_exceeded",
        details: { elapsedMs: Date.now() - this.startTime, limitMs: this.limits.maxWallTimeMs },
      };
    }

    if (this.usage.retries >= this.limits.maxRetries) {
      return {
        ok: false,
        reason: "retries_exhausted",
        details: { retries: this.usage.retries, limit: this.limits.maxRetries },
      };
    }

    const totalToolSteps = this.usage.toolSteps + this.reserved.toolSteps + (type === "tool" ? 1 : 0);
    if (totalToolSteps > this.limits.maxToolSteps) {
      return {
        ok: false,
        reason: "tool_steps_exhausted",
        details: { toolSteps: this.usage.toolSteps, reserved: this.reserved.toolSteps, limit: this.limits.maxToolSteps },
      };
    }

    const totalModelCalls = this.usage.modelCalls + this.reserved.modelCalls + (type === "model" ? 1 : 0);
    if (totalModelCalls > this.limits.maxModelCalls) {
      return {
        ok: false,
        reason: "model_calls_exhausted",
        details: { modelCalls: this.usage.modelCalls, reserved: this.reserved.modelCalls, limit: this.limits.maxModelCalls },
      };
    }

    if (this.usage.tokensUsed + this.reserved.tokens > this.limits.maxTokens) {
      return {
        ok: false,
        reason: "tokens_exhausted",
        details: { tokensUsed: this.usage.tokensUsed, reserved: this.reserved.tokens, limit: this.limits.maxTokens },
      };
    }

    if (this.usage.costUsd + this.reserved.costUsd > this.limits.maxCostUsd) {
      return {
        ok: false,
        reason: "cost_exhausted",
        details: { costUsd: this.usage.costUsd, reserved: this.reserved.costUsd, limit: this.limits.maxCostUsd },
      };
    }

    return { ok: true };
  }

  reserve({ type = "model", estimatedTokens, estimatedCost } = {}) {
    const check = this.checkBudget(type);
    if (!check.ok) {
      throw new BudgetExhaustedError(check.reason, check.details);
    }

    const id = `res_${++this.reservationCounter}`;
    const tokenEst = Number.isFinite(estimatedTokens) && estimatedTokens > 0
      ? estimatedTokens
      : CONSERVATIVE_ESTIMATES.totalTokens;
    const costEst = Number.isFinite(estimatedCost) && estimatedCost > 0
      ? estimatedCost
      : CONSERVATIVE_ESTIMATES.costUsd;

    const reservation = {
      id,
      type,
      tokens: type === "model" ? tokenEst : 0,
      costUsd: type === "model" ? costEst : 0,
      toolSteps: type === "tool" ? 1 : 0,
      modelCalls: type === "model" ? 1 : 0,
    };

    this.reserved.toolSteps += reservation.toolSteps;
    this.reserved.modelCalls += reservation.modelCalls;
    this.reserved.tokens += reservation.tokens;
    this.reserved.costUsd += reservation.costUsd;

    this.activeReservations.set(id, reservation);
    return id;
  }

  reconcile(reservationId, { actualTokens, actualCost, retried = false } = {}) {
    const reservation = this.activeReservations.get(reservationId);
    if (!reservation) {
      return;
    }

    this.activeReservations.delete(reservationId);
    this.reserved.toolSteps = Math.max(0, this.reserved.toolSteps - reservation.toolSteps);
    this.reserved.modelCalls = Math.max(0, this.reserved.modelCalls - reservation.modelCalls);
    this.reserved.tokens = Math.max(0, this.reserved.tokens - reservation.tokens);
    this.reserved.costUsd = Math.max(0, this.reserved.costUsd - reservation.costUsd);

    if (reservation.type === "tool") {
      this.usage.toolSteps += 1;
    } else if (reservation.type === "model") {
      this.usage.modelCalls += 1;

      // Akuntansi konservatif: jika token/cost aktual hilang atau 0, gunakan estimasi konservatif
      const finalTokens = Number.isFinite(actualTokens) && actualTokens > 0
        ? actualTokens
        : CONSERVATIVE_ESTIMATES.totalTokens;
      const finalCost = Number.isFinite(actualCost) && actualCost > 0
        ? actualCost
        : CONSERVATIVE_ESTIMATES.costUsd;

      this.usage.tokensUsed += finalTokens;
      this.usage.costUsd += finalCost;
    }

    if (retried) {
      this.usage.retries += 1;
    }
  }

  // Rekonsiliasi percobaan tool yang sudah mulai tetapi gagal/timeout/dibatalkan
  // Langkah tool tetap dihitung (usage.toolSteps bertambah), tanpa mengenakan biaya token model
  reconcileToolAttempt(reservationId) {
    this.reconcile(reservationId);
  }

  // Melepaskan reservasi TANPA menambah usage.toolSteps (HANYA jika handler BELUM dimulai)
  release(reservationId) {
    const reservation = this.activeReservations.get(reservationId);
    if (!reservation) return;

    this.activeReservations.delete(reservationId);
    this.reserved.toolSteps = Math.max(0, this.reserved.toolSteps - reservation.toolSteps);
    this.reserved.modelCalls = Math.max(0, this.reserved.modelCalls - reservation.modelCalls);
    this.reserved.tokens = Math.max(0, this.reserved.tokens - reservation.tokens);
    this.reserved.costUsd = Math.max(0, this.reserved.costUsd - reservation.costUsd);
  }

  // Mencatat retry: menolak jika sudah mencapai batas maxRetries
  recordRetry() {
    if (this.usage.retries >= this.limits.maxRetries) {
      throw new BudgetExhaustedError("retries_exhausted", {
        retries: this.usage.retries,
        limit: this.limits.maxRetries,
      });
    }
    this.usage.retries += 1;
    return this.usage.retries;
  }

  getSnapshot() {
    return {
      elapsedMs: Date.now() - this.startTime,
      limits: { ...this.limits },
      usage: { ...this.usage },
      reserved: { ...this.reserved },
      activeReservationCount: this.activeReservations.size,
      remaining: {
        toolSteps: Math.max(0, this.limits.maxToolSteps - (this.usage.toolSteps + this.reserved.toolSteps)),
        modelCalls: Math.max(0, this.limits.maxModelCalls - (this.usage.modelCalls + this.reserved.modelCalls)),
        tokens: Math.max(0, this.limits.maxTokens - (this.usage.tokensUsed + this.reserved.tokens)),
        costUsd: Math.max(0, Number((this.limits.maxCostUsd - (this.usage.costUsd + this.reserved.costUsd)).toFixed(6))),
      },
    };
  }
}

module.exports = {
  TaskBudget,
  BudgetExhaustedError,
  DEFAULT_LIMITS,
  CONSERVATIVE_ESTIMATES,
};
