/**
 * Process Lock untuk Runtime Durable (Fase 2)
 *
 * Mencegah dua instance proses bot produksi mengakses database SQLite yang sama
 * tanpa mode worker resmi (mencegah double-instance bug seperti yang dicatat di AGENTS.md).
 */

class ProcessLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessLockError";
    this.code = "process_lock_held";
    this.details = details;
  }
}

class ProcessLock {
  constructor(storage, {
    workerId = `pid_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
    lockId = "primary_instance",
    leaseDurationMs = 15_000,
    heartbeatIntervalMs = 5_000,
  } = {}) {
    this.storage = storage;
    this.workerId = workerId;
    this.lockId = lockId;
    this.leaseDurationMs = leaseDurationMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.fencingToken = null;
    this.heartbeatTimer = null;
    this.held = false;
  }

  async acquire() {
    const result = await this.storage.acquireLease({
      resourceType: "process_lock",
      resourceId: this.lockId,
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });

    if (!result.acquired) {
      throw new ProcessLockError(
        `Database sedang dikunci oleh proses lain (${result.currentWorker}). Batalkan startup untuk mencegah konflik.`,
        { lockId: this.lockId, currentWorker: result.currentWorker, leaseUntil: result.leaseUntil },
      );
    }

    this.fencingToken = result.fencingToken;
    this.held = true;

    // Mulai timer heartbeat berkala
    this.heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.storage.renewLease({
          resourceType: "process_lock",
          resourceId: this.lockId,
          workerId: this.workerId,
          fencingToken: this.fencingToken,
          leaseDurationMs: this.leaseDurationMs,
        });
        if (!renewed) {
          console.warn("[PROCESS_LOCK] Gagal memperbarui lock heartbeat");
        }
      } catch (err) {
        console.error("[PROCESS_LOCK] Error saat heartbeat:", err.message);
      }
    }, this.heartbeatIntervalMs);

    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }

    return true;
  }

  async release() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.held && this.fencingToken) {
      try {
        await this.storage.releaseLease({
          resourceType: "process_lock",
          resourceId: this.lockId,
          workerId: this.workerId,
          fencingToken: this.fencingToken,
        });
      } catch {}
      this.held = false;
      this.fencingToken = null;
    }
  }
}

module.exports = {
  ProcessLock,
  ProcessLockError,
};
