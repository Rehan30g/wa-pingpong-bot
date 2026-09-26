/**
 * Lease & Fencing Manager untuk Runtime Durable (Fase 2)
 *
 * Mengatur claim task & job menggunakan:
 * - worker_id
 * - lease_until
 * - fencing_token (monotonik naik)
 *
 * Menjamin:
 * - Hanya worker dengan fencing token terbaru yang diizinkan checkpoint atau complete.
 * - Lease yang kedaluwarsa dapat diambil alih (takeover) oleh worker lain.
 * - Worker lama yang mencoba menulis setelah lease takeover wajib ditolak (StaleFencingTokenError).
 * - Aman terhadap 2 worker yang berebut resource yang sama secara bersamaan.
 */

class StaleFencingTokenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StaleFencingTokenError";
    this.code = "stale_fencing_token";
    this.details = details;
  }
}

class LeaseLostError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaseLostError";
    this.code = "lease_lost";
    this.details = details;
  }
}

class LeaseManager {
  constructor(storage, { defaultLeaseDurationMs = 30000 } = {}) {
    this.storage = storage;
    this.defaultLeaseDurationMs = defaultLeaseDurationMs;
  }

  /**
   * Mengklaim task untuk eksekusi oleh worker
   */
  async claimTask(taskId, { workerId, leaseDurationMs = this.defaultLeaseDurationMs }) {
    const nowMs = Date.now();
    const leaseUntil = nowMs + leaseDurationMs;
    const nowIso = new Date().toISOString();

    let tx = null;
    try {
      tx = await this.storage.db.transaction("write");
    } catch (err) {
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return null;
      }
      throw err;
    }
    try {
      const curRes = await tx.execute({
        sql: "SELECT * FROM tasks WHERE task_id = ?;",
        args: [taskId],
      });

      if (curRes.rows.length === 0) {
        await tx.rollback();
        return null;
      }

      const current = curRes.rows[0];
      const isClaimable =
        (current.status === "queued" || current.status === "retry_wait") ||
        ((current.status === "running" || current.status === "verifying") &&
          current.lease_until != null &&
          Number(current.lease_until) < nowMs);

      if (!isClaimable) {
        await tx.rollback();
        return null;
      }

      const nextFencingToken = Number(current.fencing_token || 0) + 1;
      const nextVersion = Number(current.version || 1) + 1;

      const updateRes = await tx.execute({
        sql: `
          UPDATE tasks
          SET status = 'running',
              worker_id = ?,
              lease_until = ?,
              fencing_token = ?,
              version = ?,
              updated_at = ?
          WHERE task_id = ? AND fencing_token = ? AND version = ?;
        `,
        args: [
          workerId,
          leaseUntil,
          nextFencingToken,
          nextVersion,
          nowIso,
          taskId,
          current.fencing_token,
          current.version,
        ],
      });

      if (updateRes.rowsAffected === 0) {
        await tx.rollback();
        return null;
      }

      // Catat juga ke worker_leases untuk tracking lintas resource
      await tx.execute({
        sql: `
          INSERT OR REPLACE INTO worker_leases (
            resource_type, resource_id, worker_id, lease_until, fencing_token, updated_at
          ) VALUES ('task', ?, ?, ?, ?, ?);
        `,
        args: [taskId, workerId, leaseUntil, nextFencingToken, nowIso],
      });

      await tx.commit();
      return {
        claimed: true,
        taskId,
        workerId,
        fencingToken: nextFencingToken,
        leaseUntil,
      };
    } catch (err) {
      try { if (tx) await tx.rollback(); } catch {}
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Memvalidasi apakah worker dan fencingToken masih sah pada task
   */
  async assertTaskLease(taskId, { workerId, fencingToken }) {
    const task = await this.storage.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} tidak ditemukan`);

    if (task.worker_id !== workerId) {
      throw new LeaseLostError(
        `Lease task ${taskId} telah berpindah ke worker lain (${task.worker_id}), bukan ${workerId}`,
        { taskId, workerId, currentWorker: task.worker_id },
      );
    }

    if (Number(task.fencing_token) !== Number(fencingToken)) {
      throw new StaleFencingTokenError(
        `Fencing token usang untuk task ${taskId}: token pemanggil ${fencingToken}, token database ${task.fencing_token}`,
        { taskId, workerId, callerToken: fencingToken, dbToken: task.fencing_token },
      );
    }

    return task;
  }

  /**
   * Checkpoint langkah task: hanya diizinkan jika worker memegang fencing token terbaru
   */
  async checkpointTask(taskId, { workerId, fencingToken, status = "running", leaseDurationMs = this.defaultLeaseDurationMs, updates = {} }) {
    await this.assertTaskLease(taskId, { workerId, fencingToken });

    const nowMs = Date.now();
    const leaseUntil = nowMs + leaseDurationMs;
    const nowIso = new Date().toISOString();

    const task = await this.storage.getTask(taskId);
    const newVersion = task.version + 1;

    const setClauses = ["status = ?", "lease_until = ?", "version = ?", "updated_at = ?"];
    const args = [status, leaseUntil, newVersion, nowIso];

    if (updates.budget_snapshot) {
      setClauses.push("budget_snapshot = ?");
      args.push(JSON.stringify(updates.budget_snapshot));
    }
    if (updates.evidence_refs) {
      setClauses.push("evidence_refs = ?");
      args.push(JSON.stringify(updates.evidence_refs));
    }

    args.push(taskId, workerId, fencingToken);
    const sql = `
      UPDATE tasks
      SET ${setClauses.join(", ")}
      WHERE task_id = ? AND worker_id = ? AND fencing_token = ?;
    `;

    const res = await this.storage.db.execute({ sql, args });
    if (res.rowsAffected === 0) {
      throw new StaleFencingTokenError(`Gagal melakukan checkpoint task ${taskId}: fencing token tidak cocok saat write`);
    }

    // Perbarui lease_until di worker_leases
    await this.storage.renewLease({
      resourceType: "task",
      resourceId: taskId,
      workerId,
      fencingToken,
      leaseDurationMs,
    });

    return this.storage.getTask(taskId);
  }

  /**
   * Menyelesaikan task dan melepaskan lease
   */
  async completeTask(taskId, { workerId, fencingToken, status = "succeeded", evidenceRefs = [] }) {
    await this.assertTaskLease(taskId, { workerId, fencingToken });

    const nowIso = new Date().toISOString();
    const task = await this.storage.getTask(taskId);

    const res = await this.storage.db.execute({
      sql: `
        UPDATE tasks
        SET status = ?,
            lease_until = NULL,
            evidence_refs = ?,
            version = version + 1,
            updated_at = ?
        WHERE task_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [status, JSON.stringify(evidenceRefs), nowIso, taskId, workerId, fencingToken],
    });

    if (res.rowsAffected === 0) {
      throw new StaleFencingTokenError(`Gagal menyelesaikan task ${taskId}: fencing token tidak cocok`);
    }

    // Hapus lease dari worker_leases
    await this.storage.releaseLease({
      resourceType: "task",
      resourceId: taskId,
      workerId,
      fencingToken,
    });

    return this.storage.getTask(taskId);
  }

  /**
   * Mengambil kembali semua task/job dengan lease kedaluwarsa
   */
  async recoverExpiredLeases(nowMs = Date.now()) {
    // Reset tasks running yang expired ke retry_wait
    const taskRes = await this.storage.db.execute({
      sql: `
        UPDATE tasks
        SET status = 'retry_wait',
            worker_id = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?;
      `,
      args: [new Date().toISOString(), nowMs],
    });

    // Reset jobs running/claimed yang expired ke retry_wait
    const jobRes = await this.storage.db.execute({
      sql: `
        UPDATE jobs
        SET status = 'retry_wait',
            worker_id = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE status IN ('claimed', 'running') AND lease_until IS NOT NULL AND lease_until < ?;
      `,
      args: [new Date().toISOString(), nowMs],
    });

    return {
      recoveredTasks: taskRes.rowsAffected || 0,
      recoveredJobs: jobRes.rowsAffected || 0,
    };
  }
}

module.exports = {
  LeaseManager,
  StaleFencingTokenError,
  LeaseLostError,
};
