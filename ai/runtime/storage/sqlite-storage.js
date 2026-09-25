/**
 * Implementasi SQLite Storage untuk Runtime Durable (Fase 2)
 */

const { redactObject } = require("../../observability/redact");
const { randomUUID } = require("node:crypto");

function memoryTopicKey(text) {
  const match = /^([^:\n]{2,60}):\s*\S/.exec(String(text || "").trim());
  return match ? match[1].trim().toLocaleLowerCase("id-ID").replace(/\s+/g, " ") : null;
}

class OptimisticConcurrencyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OptimisticConcurrencyError";
    this.code = "concurrency_conflict";
    this.details = details;
  }
}

class LeaseConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaseConflictError";
    this.code = "lease_conflict";
    this.details = details;
  }
}

class StaleFencingTokenError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StaleFencingTokenError";
    this.code = "stale_fencing_token";
    this.details = details;
  }
}

class SqliteStorage {
  constructor(db) {
    this.db = db;
    this.chatEpochs = new Map();
    this._writeQueue = Promise.resolve();
  }

  async _serializeWrite(fn) {
    const prev = this._writeQueue || Promise.resolve();
    let resolve;
    this._writeQueue = new Promise((r) => { resolve = r; });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  async reserveEgress({ taskId, host, atMs = Date.now(), perTask = 4, perHostPerMinute = 20 }) {
    if (!taskId || !host) throw new Error("egress_scope_required");
    return this._serializeWrite(async () => {
      const tx = await this.db.transaction("write");
      try {
        await tx.execute({ sql: "DELETE FROM egress_host_hits WHERE at_ms <= ?;", args: [atMs - 60_000] });
        const task = await tx.execute({ sql: "SELECT request_count FROM egress_task_usage WHERE task_id = ?;", args: [taskId] });
        const used = Number(task.rows[0]?.request_count || 0);
        if (used >= perTask) throw new Error("egress_task_quota");
        const hits = await tx.execute({ sql: "SELECT COUNT(*) AS hit_count FROM egress_host_hits WHERE host = ? AND at_ms > ?;", args: [host, atMs - 60_000] });
        if (Number(hits.rows[0]?.hit_count || 0) >= perHostPerMinute) throw new Error("egress_host_rate_limit");
        await tx.execute({ sql: "INSERT INTO egress_task_usage(task_id, request_count) VALUES (?, 1) ON CONFLICT(task_id) DO UPDATE SET request_count = request_count + 1;", args: [taskId] });
        await tx.execute({ sql: "INSERT INTO egress_host_hits(hit_id, host, at_ms) VALUES (?, ?, ?);", args: [randomUUID(), host, atMs] });
        await tx.commit();
        return { taskCount: used + 1 };
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    });
  }

  async recordMemoryFact({ chatId, subjectPn, sourceEntryId, text, confidence = 1, occurredAt = null, expiresAt = null, contextEpoch = null }) {
    if (!chatId || !sourceEntryId || !/^\d{9,15}$/.test(String(subjectPn)) || !String(text || "").trim() || String(text).length > 500 || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("memory_fact_invalid");
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("memory_expiry_invalid");
    return this._serializeWrite(async () => {
      const tx = await this.db.transaction("write");
      try {
        const epochRow = await tx.execute({ sql: "SELECT context_epoch FROM chat_context_epochs WHERE chat_id = ?;", args: [chatId] });
        const currentEpoch = Number(epochRow.rows[0]?.context_epoch || 0);
        if (contextEpoch !== null && currentEpoch !== contextEpoch) throw new Error("memory_context_epoch_stale");
        const prior = await tx.execute({ sql: "SELECT * FROM memory_facts WHERE source_chat_id = ? AND source_entry_id = ? AND subject_pn = ?;", args: [chatId, String(sourceEntryId), String(subjectPn)] });
        if (prior.rows.length) {
          if (prior.rows[0].fact_text !== String(text).trim() || !["active", "conflicted"].includes(prior.rows[0].status)) throw new Error("memory_fact_source_conflict");
          await tx.commit();
          return prior.rows[0];
        }
        const topicKey = memoryTopicKey(text);
        const related = topicKey ? await tx.execute({ sql: "SELECT memory_id, fact_text FROM memory_facts WHERE source_chat_id = ? AND subject_pn = ? AND topic_key = ? AND status IN ('active','conflicted') AND (expires_at IS NULL OR expires_at > ?);", args: [chatId, String(subjectPn), topicKey, Date.now()] }) : { rows: [] };
        const hasConflict = related.rows.some((row) => row.fact_text !== String(text).trim());
        if (hasConflict) await tx.execute({ sql: "UPDATE memory_facts SET status = 'conflicted' WHERE source_chat_id = ? AND subject_pn = ? AND topic_key = ? AND status = 'active';", args: [chatId, String(subjectPn), topicKey] });
        const fact = { memory_id: `mem_${randomUUID().replace(/-/g, "")}`, subject_pn: String(subjectPn), source_chat_id: chatId, source_entry_id: String(sourceEntryId), fact_text: String(text).trim(), scope: "chat", confidence, occurred_at: occurredAt, recorded_at: new Date().toISOString(), expires_at: expiresAt, version: 1, status: hasConflict ? "conflicted" : "active", topic_key: topicKey, context_epoch: currentEpoch };
        await tx.execute({ sql: "INSERT INTO memory_facts(memory_id,subject_pn,source_chat_id,source_entry_id,fact_text,scope,confidence,occurred_at,recorded_at,expires_at,version,status,topic_key,context_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);", args: [fact.memory_id, fact.subject_pn, fact.source_chat_id, fact.source_entry_id, fact.fact_text, fact.scope, fact.confidence, fact.occurred_at, fact.recorded_at, fact.expires_at, fact.version, fact.status, fact.topic_key, fact.context_epoch] });
        await tx.commit();
        return fact;
      } catch (error) { await tx.rollback(); throw error; }
    });
  }

  async searchMemoryFacts({ chatId, actorPn, query, now = Date.now(), limit = 5 }) {
    if (!chatId || !/^\d{9,15}$/.test(String(actorPn)) || !String(query || "").trim()) throw new Error("memory_search_scope_required");
    if (chatId.endsWith("@s.whatsapp.net") && chatId !== `${actorPn}@s.whatsapp.net`) throw new Error("memory_search_scope_denied");
    const bounded = Math.max(1, Math.min(10, Number(limit) || 5));
    const rows = await this.db.execute({ sql: "SELECT * FROM memory_facts WHERE source_chat_id = ? AND scope = 'chat' AND status IN ('active','conflicted') AND (expires_at IS NULL OR expires_at > ?) ORDER BY recorded_at DESC LIMIT 200;", args: [chatId, now] });
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    return rows.rows.map((row) => ({ ...row, score: terms.reduce((sum, term) => sum + (String(row.fact_text).toLowerCase().includes(term) ? 1 : 0), 0) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || String(b.recorded_at).localeCompare(String(a.recorded_at))).slice(0, bounded);
  }

  async correctMemoryFact({ memoryId, chatId, subjectPn, sourceEntryId, text, contextEpoch }) {
    if (!/^mem_[a-f0-9]{32}$/.test(String(memoryId)) || !chatId || !sourceEntryId || !/^\d{9,15}$/.test(String(subjectPn)) || !String(text || "").trim() || String(text).length > 500 || !Number.isInteger(contextEpoch)) throw new Error("memory_correction_invalid");
    return this._serializeWrite(async () => {
      const tx = await this.db.transaction("write");
      try {
        const epoch = await tx.execute({ sql: "SELECT context_epoch FROM chat_context_epochs WHERE chat_id = ?;", args: [chatId] });
        if (Number(epoch.rows[0]?.context_epoch || 0) !== contextEpoch) throw new Error("memory_context_epoch_stale");
        const prior = await tx.execute({ sql: "SELECT * FROM memory_facts WHERE memory_id = ? AND source_chat_id = ? AND subject_pn = ?;", args: [memoryId, chatId, String(subjectPn)] });
        if (!prior.rows.length) throw new Error("memory_correction_scope_denied");
        const old = prior.rows[0];
        const replay = await tx.execute({ sql: "SELECT * FROM memory_facts WHERE source_chat_id = ? AND source_entry_id = ? AND subject_pn = ?;", args: [chatId, String(sourceEntryId), String(subjectPn)] });
        if (replay.rows.length) {
          const existing = replay.rows[0];
          if (existing.conflict_key !== memoryId || existing.fact_text !== String(text).trim() || !["active", "conflicted"].includes(existing.status)) throw new Error("memory_correction_conflict");
          await tx.commit();
          return existing;
        }
        if (!["active", "conflicted"].includes(old.status)) throw new Error("memory_correction_stale");
        if (old.topic_key && memoryTopicKey(text) !== old.topic_key) throw new Error("memory_correction_topic_mismatch");
        const siblings = old.topic_key ? await tx.execute({ sql: "SELECT fact_text FROM memory_facts WHERE source_chat_id = ? AND subject_pn = ? AND topic_key = ? AND memory_id != ? AND status IN ('active','conflicted');", args: [chatId, String(subjectPn), old.topic_key, memoryId] }) : { rows: [] };
        const hasConflict = siblings.rows.some((row) => row.fact_text !== String(text).trim());
        const fact = { memory_id: `mem_${randomUUID().replace(/-/g, "")}`, subject_pn: String(subjectPn), source_chat_id: chatId, source_entry_id: String(sourceEntryId), fact_text: String(text).trim(), scope: "chat", confidence: 1, occurred_at: null, recorded_at: new Date().toISOString(), expires_at: null, version: Number(old.version) + 1, status: hasConflict ? "conflicted" : "active", conflict_key: memoryId, topic_key: old.topic_key, context_epoch: contextEpoch };
        await tx.execute({ sql: "UPDATE memory_facts SET status = 'corrected' WHERE memory_id = ? AND status IN ('active','conflicted');", args: [memoryId] });
        await tx.execute({ sql: "INSERT INTO memory_facts(memory_id,subject_pn,source_chat_id,source_entry_id,fact_text,scope,confidence,occurred_at,recorded_at,expires_at,version,status,conflict_key,topic_key,context_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);", args: [fact.memory_id, fact.subject_pn, fact.source_chat_id, fact.source_entry_id, fact.fact_text, fact.scope, fact.confidence, fact.occurred_at, fact.recorded_at, fact.expires_at, fact.version, fact.status, fact.conflict_key, fact.topic_key, fact.context_epoch] });
        await tx.commit();
        return fact;
      } catch (error) { await tx.rollback(); throw error; }
    });
  }

  async getMemoryFact(memoryId, chatId) {
    if (!memoryId || !chatId) return null;
    const result = await this.db.execute({ sql: "SELECT * FROM memory_facts WHERE memory_id = ? AND source_chat_id = ? AND status IN ('active','conflicted') AND (expires_at IS NULL OR expires_at > ?);", args: [memoryId, chatId, Date.now()] });
    return result.rows[0] || null;
  }

  // ==========================================
  // 0. CHAT CONTEXT EPOCHS
  // ==========================================

  async loadEpochs() {
    try {
      const res = await this.db.execute("SELECT chat_id, context_epoch FROM chat_context_epochs;");
      for (const row of res.rows) {
        this.chatEpochs.set(row.chat_id, Number(row.context_epoch || 0));
      }
    } catch {}
  }

  getChatEpoch(chatId) {
    if (!chatId) return 0;
    return this.chatEpochs.get(chatId) || 0;
  }

  async getChatEpochAsync(chatId) {
    if (!chatId) return 0;
    try {
      const res = await this.db.execute({
        sql: "SELECT context_epoch FROM chat_context_epochs WHERE chat_id = ?;",
        args: [chatId],
      });
      if (res.rows.length === 0) {
        return this.chatEpochs.get(chatId) || 0;
      }
      const val = Number(res.rows[0].context_epoch || 0);
      this.chatEpochs.set(chatId, val);
      return val;
    } catch {
      return this.chatEpochs.get(chatId) || 0;
    }
  }

  bumpChatEpoch(chatId, { reason = "manual_bump" } = {}) {
    if (!chatId) return 0;
    const current = this.getChatEpoch(chatId);
    const nextEpoch = current + 1;
    this.chatEpochs.set(chatId, nextEpoch);

    const promise = this._serializeWrite(async () => {
      const now = new Date().toISOString();
      const statements = [
        {
          sql: `
            INSERT INTO chat_context_epochs (chat_id, context_epoch, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET context_epoch = excluded.context_epoch, updated_at = excluded.updated_at;
          `,
          args: [chatId, nextEpoch, now],
        },
        {
          sql: `
            UPDATE tasks
            SET status = 'cancelled', updated_at = ?
            WHERE chat_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'budget_exhausted');
          `,
          args: [now, chatId],
        },
        {
          sql: `
            UPDATE outbox
            SET status = 'cancelled', updated_at = ?, error_message = 'Context epoch kadaluwarsa (dibatalkan oleh epoch bump)'
            WHERE (destination = ? OR task_id IN (SELECT task_id FROM tasks WHERE chat_id = ?))
              AND status NOT IN ('delivered', 'failed', 'cancelled');
          `,
          args: [now, chatId, chatId],
        },
      ];
      if (reason === "reset") statements.push({ sql: "UPDATE memory_facts SET status = 'tombstoned' WHERE source_chat_id = ? AND status IN ('active','conflicted');", args: [chatId] });
      await this.db.batch(statements, "write");
      return nextEpoch;
    });

    const thenable = promise.then(() => nextEpoch);
    thenable.valueOf = () => nextEpoch;
    thenable[Symbol.toPrimitive] = (hint) => (hint === "string" ? String(nextEpoch) : nextEpoch);
    return thenable;
  }

  // ==========================================
  // 1. TASKS
  // ==========================================

  async createTask(task) {
    const now = new Date().toISOString();
    const taskId = task.task_id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = `
      INSERT INTO tasks (
        task_id, goal, acceptance_criteria, actor_pn, chat_id,
        source_event_id, scope, authorization_ref, context_epoch,
        plan_version, status, budget_snapshot, evidence_refs,
        version, worker_id, lease_until, fencing_token,
        risk_level, provenance,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      taskId,
      task.goal,
      task.acceptance_criteria || null,
      task.actor_pn,
      task.chat_id,
      task.source_event_id || null,
      task.scope || "active_chat",
      task.authorization_ref || null,
      Number(task.context_epoch || 0),
      Number(task.plan_version || 1),
      task.status || "queued",
      task.budget_snapshot ? JSON.stringify(task.budget_snapshot) : null,
      task.evidence_refs ? JSON.stringify(task.evidence_refs) : null,
      1, // version
      task.worker_id || null,
      task.lease_until ? Number(task.lease_until) : null,
      Number(task.fencing_token || 0),
      task.risk_level || "low",
      task.provenance || null,
      now,
      now,
    ];

    await this.db.execute({ sql, args });
    return this.getTask(taskId);
  }

  async getTask(taskId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM tasks WHERE task_id = ?;",
      args: [taskId],
    });
    if (res.rows.length === 0) return null;
    return this._formatTask(res.rows[0]);
  }

  async updateTask(taskId, { expectedVersion, ...updates }) {
    if (expectedVersion == null) {
      throw new Error("expectedVersion wajib disertakan untuk updateTask (optimistic concurrency)");
    }

    const current = await this.getTask(taskId);
    if (!current) {
      throw new Error(`Task ${taskId} tidak ditemukan`);
    }

    if (current.version !== Number(expectedVersion)) {
      throw new OptimisticConcurrencyError(
        `Konflik konkurensi pada task ${taskId}: versi sekarang ${current.version}, expected ${expectedVersion}`,
        { taskId, currentVersion: current.version, expectedVersion },
      );
    }

    const now = new Date().toISOString();
    const newVersion = current.version + 1;

    const setClauses = ["version = ?", "updated_at = ?"];
    const args = [newVersion, now];

    const fields = [
      "goal",
      "acceptance_criteria",
      "actor_pn",
      "chat_id",
      "source_event_id",
      "scope",
      "authorization_ref",
      "context_epoch",
      "plan_version",
      "status",
      "budget_snapshot",
      "evidence_refs",
      "worker_id",
      "lease_until",
      "fencing_token",
      "risk_level",
      "provenance",
    ];

    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = ?`);
        if (f === "budget_snapshot" || f === "evidence_refs") {
          args.push(updates[f] ? JSON.stringify(updates[f]) : null);
        } else {
          args.push(updates[f]);
        }
      }
    }

    args.push(taskId, expectedVersion);
    const sql = `
      UPDATE tasks
      SET ${setClauses.join(", ")}
      WHERE task_id = ? AND version = ?;
    `;

    const res = await this.db.execute({ sql, args });
    if (res.rowsAffected === 0) {
      throw new OptimisticConcurrencyError(`Gagal memperbarui task ${taskId} karena konflik versi`, {
        taskId,
        expectedVersion,
      });
    }

    return this.getTask(taskId);
  }

  async listTasks({ status, chatId, actorPn, limit = 50 } = {}) {
    const conditions = [];
    const args = [];

    if (status) {
      conditions.push("status = ?");
      args.push(status);
    }
    if (chatId) {
      conditions.push("chat_id = ?");
      args.push(chatId);
    }
    if (actorPn) {
      conditions.push("actor_pn = ?");
      args.push(actorPn);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?;`;
    args.push(limit);

    const res = await this.db.execute({ sql, args });
    return res.rows.map((row) => this._formatTask(row));
  }

  _formatTask(row) {
    return {
      ...row,
      context_epoch: Number(row.context_epoch || 0),
      plan_version: Number(row.plan_version || 1),
      version: Number(row.version || 1),
      lease_until: row.lease_until != null ? Number(row.lease_until) : null,
      fencing_token: Number(row.fencing_token || 0),
      budget_snapshot: row.budget_snapshot ? JSON.parse(row.budget_snapshot) : null,
      evidence_refs: row.evidence_refs ? JSON.parse(row.evidence_refs) : [],
      risk_level: row.risk_level || "low",
      provenance: row.provenance || null,
    };
  }

  async completeTaskWithOutboxIntent({
    taskId,
    workerId,
    fencingToken,
    terminalStatus = "succeeded",
    evidenceRefs = [],
    outboxIntent = null,
  }) {
    return this._serializeWrite(async () => {
      const nowIso = new Date().toISOString();
      const tx = await this.db.transaction("write");
      try {
        let finalStatus = terminalStatus;
        let outboxRecord = null;

        if (outboxIntent && outboxIntent.idempotency_key) {
          // 1. Cek apakah outbox intent sudah ada
          const existingRes = await tx.execute({
            sql: "SELECT * FROM outbox WHERE idempotency_key = ?;",
            args: [outboxIntent.idempotency_key],
          });

          if (existingRes.rows.length > 0) {
            outboxRecord = this._formatOutbox(existingRes.rows[0]);
            // Status outbox menentukan status task secara jujur
            if (outboxRecord.status === "uncertain") {
              finalStatus = "delivery_uncertain";
            } else if (outboxRecord.status === "cancelled") {
              finalStatus = "cancelled";
            }
          } else {
            // Buat intent outbox baru dalam transaksi atomik
            const outboxId = outboxIntent.outbox_id || `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const sqlOut = `
              INSERT INTO outbox (
                outbox_id, task_id, job_id, destination, content_type,
                payload, idempotency_key, context_epoch, status,
                transport_message_id, attempts, max_attempts, worker_id,
                lease_until, fencing_token, delivery_receipt, error_message,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(idempotency_key) DO NOTHING;
            `;
            const argsOut = [
              outboxId,
              taskId,
              null,
              outboxIntent.destination,
              outboxIntent.content_type || "text",
              typeof outboxIntent.payload === "string" ? outboxIntent.payload : JSON.stringify(outboxIntent.payload || {}),
              outboxIntent.idempotency_key,
              Number(outboxIntent.context_epoch || 0),
              outboxIntent.status || "pending",
              null,
              0,
              Number(outboxIntent.max_attempts || 3),
              null,
              null,
              0,
              null,
              null,
              nowIso,
              nowIso,
            ];
            await tx.execute({ sql: sqlOut, args: argsOut });

            const refetchRes = await tx.execute({
              sql: "SELECT * FROM outbox WHERE idempotency_key = ?;",
              args: [outboxIntent.idempotency_key],
            });
            if (refetchRes.rows.length > 0) {
              outboxRecord = this._formatOutbox(refetchRes.rows[0]);
            }
          }
        }

        // 2. Update task transisi status terminal
        const updateTaskRes = await tx.execute({
          sql: `
            UPDATE tasks
            SET status = ?,
                lease_until = NULL,
                evidence_refs = ?,
                version = version + 1,
                updated_at = ?
            WHERE task_id = ? AND worker_id = ? AND fencing_token = ?;
          `,
          args: [finalStatus, JSON.stringify(evidenceRefs), nowIso, taskId, workerId, fencingToken],
        });

        if (updateTaskRes.rowsAffected === 0) {
          // Fencing token tidak cocok atau task sudah berubah
          const curTaskRes = await tx.execute({
            sql: "SELECT * FROM tasks WHERE task_id = ?;",
            args: [taskId],
          });
          if (curTaskRes.rows.length > 0) {
            const currentTask = this._formatTask(curTaskRes.rows[0]);
            if (currentTask.status === "succeeded" || currentTask.status === finalStatus) {
              await tx.commit();
              return { task: currentTask, outbox: outboxRecord };
            }
          }
          await tx.rollback();
          throw new StaleFencingTokenError(`Gagal menyelesaikan task ${taskId}: fencing token tidak cocok`);
        }

        // 3. Release lease di worker_leases
        await tx.execute({
          sql: `
            DELETE FROM worker_leases
            WHERE resource_type = 'task' AND resource_id = ? AND worker_id = ? AND fencing_token = ?;
          `,
          args: [taskId, workerId, fencingToken],
        });

        await tx.commit();

        const finalTask = await this.getTask(taskId);
        return { task: finalTask, outbox: outboxRecord };
      } catch (err) {
        try {
          await tx.rollback();
        } catch {}
        throw err;
      }
    });
  }

  // ==========================================
  // 2. TASK STEPS
  // ==========================================

  async createTaskStep(step) {
    const now = new Date().toISOString();
    const stepId = step.step_id || `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = `
      INSERT INTO task_steps (
        step_id, task_id, step_index, capability_name, logical_operation_id,
        idempotency_key, status, input_redacted, observation_redacted,
        evidence, error_code, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      stepId,
      step.task_id,
      Number(step.step_index || 0),
      step.capability_name,
      step.logical_operation_id,
      step.idempotency_key,
      step.status || "pending",
      step.input_redacted ? JSON.stringify(redactObject(step.input_redacted)) : null,
      step.observation_redacted ? JSON.stringify(redactObject(step.observation_redacted)) : null,
      step.evidence || null,
      step.error_code || null,
      1,
      now,
      now,
    ];

    await this.db.execute({ sql, args });
    return this.getTaskStep(stepId);
  }

  async getTaskStep(stepId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM task_steps WHERE step_id = ?;",
      args: [stepId],
    });
    if (res.rows.length === 0) return null;
    return this._formatStep(res.rows[0]);
  }

  async updateTaskStep(stepId, { expectedVersion, ...updates }) {
    const current = await this.getTaskStep(stepId);
    if (!current) throw new Error(`Task step ${stepId} tidak ditemukan`);

    if (expectedVersion != null && current.version !== Number(expectedVersion)) {
      throw new OptimisticConcurrencyError(`Konflik konkurensi pada step ${stepId}`);
    }

    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const setClauses = ["version = ?", "updated_at = ?"];
    const args = [newVersion, now];

    const fields = ["status", "input_redacted", "observation_redacted", "evidence", "error_code"];
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = ?`);
        if (f === "input_redacted" || f === "observation_redacted") {
          args.push(updates[f] ? JSON.stringify(redactObject(updates[f])) : null);
        } else {
          args.push(updates[f]);
        }
      }
    }

    args.push(stepId);
    let sql = `UPDATE task_steps SET ${setClauses.join(", ")} WHERE step_id = ?`;
    if (expectedVersion != null) {
      sql += " AND version = ?";
      args.push(expectedVersion);
    }
    sql += ";";

    const res = await this.db.execute({ sql, args });
    if (res.rowsAffected === 0) {
      throw new OptimisticConcurrencyError(`Gagal memperbarui step ${stepId}`);
    }
    return this.getTaskStep(stepId);
  }

  async getTaskSteps(taskId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index ASC;",
      args: [taskId],
    });
    return res.rows.map((row) => this._formatStep(row));
  }

  async replaceRemainingStepsForReplan({ taskId, workerId, fencingToken, failedStepIndex, newSteps, evidence }) {
    if (!Array.isArray(newSteps) || !newSteps.length) throw new Error("replan_steps_required");
    return this._serializeWrite(async () => {
      const tx = await this.db.transaction("write");
      try {
        const taskRes = await tx.execute({ sql: "SELECT * FROM tasks WHERE task_id = ?;", args: [taskId] });
        const task = taskRes.rows[0];
        if (!task || task.worker_id !== workerId || Number(task.fencing_token) !== Number(fencingToken) || task.status !== "running") {
          throw new StaleFencingTokenError("replan_task_lease_lost");
        }
        const countRes = await tx.execute({ sql: "SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?;", args: [taskId] });
        const oldCount = Number(countRes.rows[0].n);
        if (oldCount + newSteps.length > 8 || Number(task.plan_version) >= 3) throw new Error("replan_budget_exhausted");
        const failedRes = await tx.execute({ sql: "SELECT status FROM task_steps WHERE task_id = ? AND step_index = ?;", args: [taskId, failedStepIndex] });
        if (!failedRes.rows.length || failedRes.rows[0].status !== "failed") throw new Error("replan_failed_step_changed");
        const now = new Date().toISOString();
        for (let i = 0; i < newSteps.length; i++) {
          const step = newSteps[i];
          await tx.execute({
            sql: `INSERT INTO task_steps (step_id, task_id, step_index, capability_name, logical_operation_id, idempotency_key, status, input_redacted, evidence, version, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?);`,
            args: [step.step_id, taskId, oldCount + i, step.capability_name, step.logical_operation_id, step.idempotency_key, JSON.stringify(redactObject(step.input_redacted || {})), step.evidence || null, now, now],
          });
        }
        await tx.execute({
          sql: "UPDATE task_steps SET status = 'superseded', version = version + 1, updated_at = ? WHERE task_id = ? AND step_index >= ? AND step_index < ? AND status IN ('pending', 'failed');",
          args: [now, taskId, failedStepIndex, oldCount],
        });
        const refs = task.evidence_refs ? JSON.parse(task.evidence_refs) : [];
        refs.push(evidence);
        await tx.execute({
          sql: "UPDATE tasks SET plan_version = plan_version + 1, evidence_refs = ?, version = version + 1, updated_at = ? WHERE task_id = ? AND worker_id = ? AND fencing_token = ?;",
          args: [JSON.stringify(redactObject(refs)), now, taskId, workerId, fencingToken],
        });
        await tx.commit();
        return this.getTask(taskId);
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      }
    });
  }

  _formatStep(row) {
    return {
      ...row,
      step_index: Number(row.step_index),
      version: Number(row.version),
      input_redacted: row.input_redacted ? JSON.parse(row.input_redacted) : null,
      observation_redacted: row.observation_redacted ? JSON.parse(row.observation_redacted) : null,
    };
  }

  // ==========================================
  // 3. INBOX & DEDUPLICATION (TRANSACTIONAL)
  // ==========================================

  async insertEventAndEnqueueTask({ event, task = null } = {}) {
    if (!event.participant_pn || typeof event.participant_pn !== "string") {
      throw new Error("participant_pn wajib non-empty string");
    }
    // Fail-closed jika raw LID terdeteksi
    if (event.participant_pn.includes("@lid") || event.participant_pn.endsWith(".lid")) {
      throw new Error("Raw WhatsApp LID ditolak sebagai participant_pn identity");
    }

    let tx = null;
    try {
      tx = await this.db.transaction("write");
    } catch (err) {
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return { duplicate: true, eventId: null, task: null };
      }
      throw err;
    }
    try {
      // 1. Cek duplikasi inbox event
      const checkRes = await tx.execute({
        sql: `
          SELECT event_id, processed_at FROM inbox_events
          WHERE transport = ? AND chat_id = ? AND participant_pn = ? AND source_event_id = ?;
        `,
        args: [event.transport, event.chat_id, event.participant_pn, event.source_event_id],
      });

      if (checkRes.rows.length > 0) {
        // Event duplicate ditemukan! Jangan buat task baru.
        await tx.rollback();
        return {
          duplicate: true,
          eventId: checkRes.rows[0].event_id,
          task: null,
        };
      }

      // 2. Insert event baru
      const now = new Date().toISOString();
      const eventId = event.event_id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.execute({
        sql: `
          INSERT INTO inbox_events (
            event_id, transport, chat_id, participant_pn, source_event_id,
            payload_redacted, context_epoch, processed_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
        args: [
          eventId,
          event.transport,
          event.chat_id,
          event.participant_pn,
          event.source_event_id,
          event.payload_redacted ? JSON.stringify(redactObject(event.payload_redacted)) : null,
          Number(event.context_epoch || 0),
          event.processed_at || null,
          now,
        ],
      });

      // 3. Jika disertakan task, enqueue task dalam transaksi yang sama
      let createdTaskId = null;
      if (task) {
        createdTaskId = task.task_id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await tx.execute({
          sql: `
            INSERT INTO tasks (
              task_id, goal, acceptance_criteria, actor_pn, chat_id,
              source_event_id, scope, authorization_ref, context_epoch,
              plan_version, status, budget_snapshot, evidence_refs,
              version, worker_id, lease_until, fencing_token,
              risk_level, provenance,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
          `,
          args: [
            createdTaskId,
            task.goal,
            task.acceptance_criteria || null,
            event.participant_pn,
            event.chat_id,
            event.source_event_id,
            task.scope || "active_chat",
            task.authorization_ref || null,
            Number(event.context_epoch || task.context_epoch || 0),
            1,
            task.status || "queued",
            task.budget_snapshot ? JSON.stringify(task.budget_snapshot) : null,
            task.evidence_refs ? JSON.stringify(task.evidence_refs) : null,
            1,
            null,
            null,
            0,
            task.risk_level || "low",
            task.provenance || "runtime_inbound_message",
            now,
            now,
          ],
        });
      }

      await tx.commit();

      const createdTask = createdTaskId ? await this.getTask(createdTaskId) : null;
      return {
        duplicate: false,
        eventId,
        task: createdTask,
      };
    } catch (err) {
      try { await tx.rollback(); } catch {}
      // Jika constraint violation terjadi karena race condition
      if (String(err.message).includes("UNIQUE constraint failed") || String(err.message).includes("uq_inbox_dedup")) {
        return { duplicate: true, eventId: null, task: null };
      }
      throw err;
    }
  }

  async getInboxEvent(eventId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM inbox_events WHERE event_id = ?;",
      args: [eventId],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      context_epoch: Number(row.context_epoch || 0),
      payload_redacted: row.payload_redacted ? JSON.parse(row.payload_redacted) : null,
    };
  }

  // ==========================================
  // 4. JOBS (DURABLE SCHEDULER)
  // ==========================================

  async createJob(job) {
    const now = new Date().toISOString();
    const jobId = job.job_id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = `
      INSERT INTO jobs (
        job_id, type, fire_at, payload, status,
        attempts, max_attempts, worker_id, lease_until, fencing_token,
        context_epoch, is_late, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      jobId,
      job.type,
      Number(job.fire_at),
      typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload || {}),
      job.status || "scheduled",
      Number(job.attempts || 0),
      Number(job.max_attempts || 3),
      job.worker_id || null,
      job.lease_until ? Number(job.lease_until) : null,
      Number(job.fencing_token || 0),
      Number(job.context_epoch || 0),
      job.is_late ? 1 : 0,
      now,
      now,
    ];

    await this.db.execute({ sql, args });
    return this.getJob(jobId);
  }

  async getJob(jobId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM jobs WHERE job_id = ?;",
      args: [jobId],
    });
    if (res.rows.length === 0) return null;
    return this._formatJob(res.rows[0]);
  }

  async updateJob(jobId, updates) {
    const now = new Date().toISOString();
    const setClauses = ["updated_at = ?"];
    const args = [now];

    const fields = [
      "type",
      "fire_at",
      "payload",
      "status",
      "attempts",
      "max_attempts",
      "worker_id",
      "lease_until",
      "fencing_token",
      "context_epoch",
      "is_late",
    ];

    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = ?`);
        if (f === "payload" && typeof updates[f] === "object" && updates[f] !== null) {
          args.push(JSON.stringify(updates[f]));
        } else if (f === "is_late") {
          args.push(updates[f] ? 1 : 0);
        } else {
          args.push(updates[f]);
        }
      }
    }

    args.push(jobId);
    const sql = `UPDATE jobs SET ${setClauses.join(", ")} WHERE job_id = ?;`;
    await this.db.execute({ sql, args });
    return this.getJob(jobId);
  }

  async claimJob(jobId, { workerId, leaseDurationMs = 30000 }) {
    const nowMs = Date.now();
    const leaseUntil = nowMs + leaseDurationMs;

    // Transaksi claim dengan conditional update aman terhadap konkurensi 2 worker
    let tx = null;
    try {
      tx = await this.db.transaction("write");
    } catch (err) {
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return null;
      }
      throw err;
    }
    try {
      const currentRes = await tx.execute({
        sql: "SELECT * FROM jobs WHERE job_id = ?;",
        args: [jobId],
      });

      if (currentRes.rows.length === 0) {
        await tx.rollback();
        return null;
      }

      const current = currentRes.rows[0];
      const isClaimable =
        (current.status === "scheduled" || current.status === "retry_wait") ||
        ((current.status === "claimed" || current.status === "running") &&
          current.lease_until != null &&
          current.lease_until < nowMs);

      if (!isClaimable) {
        await tx.rollback();
        return null;
      }

      const nextFencingToken = Number(current.fencing_token || 0) + 1;
      const updateRes = await tx.execute({
        sql: `
          UPDATE jobs
          SET status = 'claimed',
              worker_id = ?,
              lease_until = ?,
              fencing_token = ?,
              updated_at = ?
          WHERE job_id = ? AND fencing_token = ?;
        `,
        args: [workerId, leaseUntil, nextFencingToken, new Date().toISOString(), jobId, current.fencing_token],
      });

      if (updateRes.rowsAffected === 0) {
        await tx.rollback();
        return null;
      }

      await tx.commit();
      return this.getJob(jobId);
    } catch (err) {
      try { if (tx) await tx.rollback(); } catch {}
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return null;
      }
      throw err;
    }
  }

  async listDueJobs(nowMs = Date.now(), { limit = 20 } = {}) {
    const sql = `
      SELECT * FROM jobs
      WHERE (status = 'scheduled' OR status = 'retry_wait')
        AND fire_at <= ?
      ORDER BY fire_at ASC
      LIMIT ?;
    `;
    const res = await this.db.execute({ sql, args: [nowMs, limit] });
    return res.rows.map((row) => this._formatJob(row));
  }

  async listJobs({ status, type, limit = 50 } = {}) {
    const conditions = [];
    const args = [];
    if (status) {
      conditions.push("status = ?");
      args.push(status);
    }
    if (type) {
      conditions.push("type = ?");
      args.push(type);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM jobs ${where} ORDER BY fire_at ASC LIMIT ?;`;
    args.push(limit);

    const res = await this.db.execute({ sql, args });
    return res.rows.map((row) => this._formatJob(row));
  }

  async cancelJob(jobId) {
    const res = await this.db.execute({
      sql: "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status NOT IN ('sent', 'succeeded', 'cancelled');",
      args: [new Date().toISOString(), jobId],
    });
    return res.rowsAffected > 0;
  }

  async clearJobs() {
    await this.db.execute({
      sql: "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE status NOT IN ('sent', 'succeeded', 'cancelled');",
      args: [new Date().toISOString()],
    });
  }

  _formatJob(row) {
    let payload = {};
    try {
      payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
    } catch {}

    return {
      ...row,
      id: row.job_id,
      fire_at: Number(row.fire_at),
      attempts: Number(row.attempts || 0),
      max_attempts: Number(row.max_attempts || 3),
      lease_until: row.lease_until != null ? Number(row.lease_until) : null,
      fencing_token: Number(row.fencing_token || 0),
      context_epoch: Number(row.context_epoch || 0),
      is_late: Boolean(row.is_late),
      payload,
    };
  }

  // ==========================================
  // 5. APPROVALS
  // ==========================================

  async createApproval(approval) {
    const now = new Date().toISOString();
    const approvalId = approval.approval_id || `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = `
      INSERT INTO approvals (
        approval_id, task_id, actor_pn, capability_name, logical_operation_id,
        args_hash, scope, status, expires_at, created_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      approvalId,
      approval.task_id,
      approval.actor_pn,
      approval.capability_name,
      approval.logical_operation_id,
      approval.args_hash,
      approval.scope || "active_chat",
      approval.status || "approved",
      approval.expires_at,
      now,
      null,
    ];

    await this.db.execute({ sql, args });
    return this.getApproval(approvalId);
  }

  async getApproval(approvalId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM approvals WHERE approval_id = ?;",
      args: [approvalId],
    });
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async findValidApproval({ taskId, actorPn, capabilityName, logicalOperationId, argsHash, nowIso = new Date().toISOString() }) {
    const sql = `
      SELECT * FROM approvals
      WHERE task_id = ?
        AND actor_pn = ?
        AND capability_name = ?
        AND logical_operation_id = ?
        AND args_hash = ?
        AND status = 'approved'
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const res = await this.db.execute({
      sql,
      args: [taskId, actorPn, capabilityName, logicalOperationId, argsHash, nowIso],
    });
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async useApproval(approvalId) {
    const now = new Date().toISOString();
    const res = await this.db.execute({
      sql: "UPDATE approvals SET status = 'used', used_at = ? WHERE approval_id = ? AND status = 'approved';",
      args: [now, approvalId],
    });
    return res.rowsAffected > 0;
  }

  // ==========================================
  // 6. OUTBOX (TRANSACTIONAL OUTBOX)
  // ==========================================

  async createOutboxIntent(outbox, tx = null, { idempotent = false } = {}) {
    const isIdempotent = Boolean(idempotent || outbox.idempotent);
    const executor = tx || this.db;

    if (isIdempotent && outbox.idempotency_key) {
      const existing = await this.getOutboxByIdempotencyKey(outbox.idempotency_key, tx);
      if (existing) {
        return existing;
      }
    }

    const now = new Date().toISOString();
    const outboxId = outbox.outbox_id || `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const conflictClause = isIdempotent ? "ON CONFLICT(idempotency_key) DO NOTHING" : "";

    const sql = `
      INSERT INTO outbox (
        outbox_id, task_id, job_id, destination, content_type,
        payload, idempotency_key, context_epoch, status,
        transport_message_id, attempts, max_attempts, worker_id,
        lease_until, fencing_token, delivery_receipt, error_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause};
    `;
    const args = [
      outboxId,
      outbox.task_id || null,
      outbox.job_id || null,
      outbox.destination,
      outbox.content_type || "text",
      typeof outbox.payload === "string" ? outbox.payload : JSON.stringify(outbox.payload || {}),
      outbox.idempotency_key,
      Number(outbox.context_epoch || 0),
      outbox.status || "pending",
      outbox.transport_message_id || null,
      Number(outbox.attempts || 0),
      Number(outbox.max_attempts || 3),
      null,
      null,
      0,
      null,
      null,
      now,
      now,
    ];

    await executor.execute({ sql, args });

    if (isIdempotent && outbox.idempotency_key) {
      const existing = await this.getOutboxByIdempotencyKey(outbox.idempotency_key, tx);
      if (existing) {
        return existing;
      }
    }

    return this.getOutbox(outboxId, tx);
  }

  async ensureOutboxIntent(outbox, tx = null) {
    return this.createOutboxIntent(outbox, tx, { idempotent: true });
  }

  async getOutbox(outboxId, tx = null) {
    const executor = tx || this.db;
    const res = await executor.execute({
      sql: "SELECT * FROM outbox WHERE outbox_id = ?;",
      args: [outboxId],
    });
    if (res.rows.length === 0) return null;
    return this._formatOutbox(res.rows[0]);
  }

  async getOutboxByIdempotencyKey(key, tx = null) {
    const executor = tx || this.db;
    const res = await executor.execute({
      sql: "SELECT * FROM outbox WHERE idempotency_key = ?;",
      args: [key],
    });
    if (res.rows.length === 0) return null;
    return this._formatOutbox(res.rows[0]);
  }

  async claimOutbox(outboxId, { workerId, leaseDurationMs = 30000 }) {
    return this._serializeWrite(async () => {
      const nowMs = Date.now();
      const leaseUntil = nowMs + leaseDurationMs;

      const tx = await this.db.transaction("write");
      try {
        const curRes = await tx.execute({
          sql: "SELECT * FROM outbox WHERE outbox_id = ?;",
          args: [outboxId],
        });
        if (curRes.rows.length === 0) {
          await tx.rollback();
          return null;
        }

        const cur = curRes.rows[0];
        const isClaimable =
          (cur.status === "pending" || (cur.status === "retry_wait" && (cur.lease_until == null || Number(cur.lease_until) <= nowMs))) ||
          (cur.status === "claimed" &&
            cur.lease_until != null &&
            Number(cur.lease_until) < nowMs);

        if (!isClaimable) {
          await tx.rollback();
          return null;
        }

        const nextFencing = Number(cur.fencing_token || 0) + 1;
        const res = await tx.execute({
          sql: `
            UPDATE outbox
            SET status = 'claimed',
                worker_id = ?,
                lease_until = ?,
                fencing_token = ?,
                updated_at = ?
            WHERE outbox_id = ? AND fencing_token = ?;
          `,
          args: [workerId, leaseUntil, nextFencing, new Date().toISOString(), outboxId, cur.fencing_token],
        });

        if (res.rowsAffected === 0) {
          await tx.rollback();
          return null;
        }

        await tx.commit();
        return this.getOutbox(outboxId);
      } catch (err) {
        try { await tx.rollback(); } catch {}
        throw err;
      }
    });
  }

  async markOutboxSending(outboxId, { workerId, fencingToken }) {
    const res = await this.db.execute({
      sql: `
        UPDATE outbox
        SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE outbox_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [new Date().toISOString(), outboxId, workerId, fencingToken],
    });
    return res.rowsAffected > 0;
  }

  async markOutboxDelivered(outboxId, { workerId, fencingToken, transportMessageId, deliveryReceipt }) {
    const now = new Date().toISOString();
    const res = await this.db.execute({
      sql: `
        UPDATE outbox
        SET status = 'delivered',
            transport_message_id = ?,
            delivery_receipt = ?,
            updated_at = ?
        WHERE outbox_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [
        transportMessageId || null,
        deliveryReceipt ? JSON.stringify(deliveryReceipt) : null,
        now,
        outboxId,
        workerId,
        fencingToken,
      ],
    });
    return res.rowsAffected > 0;
  }

  async markOutboxUncertain(outboxId, { workerId = null, fencingToken = null, errorMessage }) {
    const now = new Date().toISOString();
    let sql = "UPDATE outbox SET status = 'uncertain', error_message = ?, updated_at = ? WHERE outbox_id = ?";
    const args = [errorMessage || "Pengiriman tidak pasti", now, outboxId];
    if (workerId && fencingToken != null) {
      sql += " AND worker_id = ? AND fencing_token = ?";
      args.push(workerId, fencingToken);
    }
    sql += ";";

    const res = await this.db.execute({ sql, args });
    return res.rowsAffected > 0;
  }

  async failOrRetryOutbox(outboxId, { workerId, fencingToken, errorMessage, nextAttemptAt = null }) {
    const cur = await this.getOutbox(outboxId);
    if (!cur) return false;

    const now = new Date().toISOString();
    const nextStatus = cur.attempts >= cur.max_attempts ? "failed" : "retry_wait";
    const backoffMs = nextStatus === "retry_wait"
      ? (nextAttemptAt != null ? Number(nextAttemptAt) : Date.now() + (2 ** cur.attempts) * 1000 + Math.floor(Math.random() * 500))
      : null;

    const res = await this.db.execute({
      sql: `
        UPDATE outbox
        SET status = ?, error_message = ?, lease_until = ?, worker_id = NULL, updated_at = ?
        WHERE outbox_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [nextStatus, errorMessage || null, backoffMs, now, outboxId, workerId, fencingToken],
    });
    return res.rowsAffected > 0;
  }

  async cancelOutbox(outboxId, { workerId = null, fencingToken = null, errorMessage = null } = {}) {
    const now = new Date().toISOString();
    let sql = "UPDATE outbox SET status = 'cancelled', error_message = ?, worker_id = NULL, lease_until = NULL, updated_at = ? WHERE outbox_id = ?";
    const args = [errorMessage || "Cancelled", now, outboxId];
    if (workerId && fencingToken != null) {
      sql += " AND worker_id = ? AND fencing_token = ?";
      args.push(workerId, fencingToken);
    }
    sql += ";";
    const res = await this.db.execute({ sql, args });
    return res.rowsAffected > 0;
  }

  async reconcileOutbox(outboxId, { status, transportMessageId, deliveryReceipt }) {
    const now = new Date().toISOString();
    const res = await this.db.execute({
      sql: `
        UPDATE outbox
        SET status = ?,
            transport_message_id = COALESCE(?, transport_message_id),
            delivery_receipt = COALESCE(?, delivery_receipt),
            updated_at = ?
        WHERE outbox_id = ?;
      `,
      args: [
        status,
        transportMessageId || null,
        deliveryReceipt ? JSON.stringify(deliveryReceipt) : null,
        now,
        outboxId,
      ],
    });
    return res.rowsAffected > 0;
  }

  async listPendingOutbox({ limit = 50, nowMs = Date.now() } = {}) {
    const sql = `
      SELECT * FROM outbox
      WHERE status = 'pending'
         OR (status = 'retry_wait' AND (lease_until IS NULL OR lease_until <= ?))
      ORDER BY created_at ASC
      LIMIT ?;
    `;
    const res = await this.db.execute({ sql, args: [nowMs, limit] });
    return res.rows.map((row) => this._formatOutbox(row));
  }

  async listOutbox({ limit = 50 } = {}) {
    const sql = `
      SELECT * FROM outbox
      ORDER BY created_at DESC
      LIMIT ?;
    `;
    const res = await this.db.execute({ sql, args: [limit] });
    return res.rows.map((row) => this._formatOutbox(row));
  }

  async settleAssetTaskFromOutbox(outboxId) {
    return this._serializeWrite(async () => {
      const tx = await this.db.transaction("write");
      try {
        const outboxRes = await tx.execute({ sql: "SELECT * FROM outbox WHERE outbox_id = ?;", args: [outboxId] });
        const outbox = outboxRes.rows[0];
        if (!outbox || !["image", "sticker"].includes(outbox.content_type) || !outbox.task_id) { await tx.commit(); return null; }
        const payload = JSON.parse(outbox.payload || "{}");
        const taskRes = await tx.execute({ sql: "SELECT * FROM tasks WHERE task_id = ?;", args: [outbox.task_id] });
        const task = taskRes.rows[0];
        if (!task || task.chat_id !== outbox.destination || payload.chat_id !== task.chat_id || payload.task_id !== task.task_id || Number(task.context_epoch) !== Number(outbox.context_epoch) || !["verifying", "delivery_uncertain"].includes(task.status)) {
          await tx.commit(); return null;
        }
        let status = null;
        if (outbox.status === "delivered") {
          const receipt = outbox.delivery_receipt ? JSON.parse(outbox.delivery_receipt) : null;
          status = outbox.transport_message_id || receipt?.simulated ? "succeeded" : "delivery_uncertain";
        } else if (outbox.status === "uncertain") status = "delivery_uncertain";
        else if (outbox.status === "failed") status = "failed";
        else if (outbox.status === "cancelled") status = "cancelled";
        if (!status) { await tx.commit(); return null; }
        const evidence = task.evidence_refs ? JSON.parse(task.evidence_refs) : [];
        const record = { type: "asset_delivery", outbox_id: outboxId, status, transport_message_id: outbox.transport_message_id || null };
        const existing = evidence.findIndex((item) => item?.type === "asset_delivery" && item.outbox_id === outboxId);
        if (existing >= 0) evidence[existing] = record; else evidence.push(record);
        await tx.execute({
          sql: "UPDATE tasks SET status = ?, evidence_refs = ?, version = version + 1, updated_at = ? WHERE task_id = ? AND status IN ('verifying', 'delivery_uncertain');",
          args: [status, JSON.stringify(evidence), new Date().toISOString(), task.task_id],
        });
        await tx.commit();
        return status;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      }
    });
  }

  _formatOutbox(row) {
    let payload = {};
    let deliveryReceipt = null;
    try {
      payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
    } catch {}
    try {
      deliveryReceipt = row.delivery_receipt ? JSON.parse(row.delivery_receipt) : null;
    } catch {}

    return {
      ...row,
      attempts: Number(row.attempts || 0),
      max_attempts: Number(row.max_attempts || 3),
      lease_until: row.lease_until != null ? Number(row.lease_until) : null,
      fencing_token: Number(row.fencing_token || 0),
      context_epoch: Number(row.context_epoch || 0),
      payload,
      delivery_receipt: deliveryReceipt,
    };
  }

  // ==========================================
  // 7. IDEMPOTENCY RECORDS
  // ==========================================

  async getIdempotencyRecord(key) {
    const res = await this.db.execute({
      sql: "SELECT * FROM idempotency_records WHERE idempotency_key = ?;",
      args: [key],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      result_redacted: row.result_redacted ? JSON.parse(row.result_redacted) : null,
    };
  }

  async saveIdempotencyRecord(key, { taskId, capabilityName, logicalOperationId, resultRedacted }, tx = null) {
    const executor = tx || this.db;
    const existing = await this.getIdempotencyRecord(key);
    if (existing) {
      // First-write-wins: do NOT replace! Check for conflict
      const newSerialized = resultRedacted ? JSON.stringify(redactObject(resultRedacted)) : null;
      const oldSerialized = existing.result_redacted ? JSON.stringify(existing.result_redacted) : null;
      if (existing.logical_operation_id !== logicalOperationId || (newSerialized && oldSerialized && newSerialized !== oldSerialized)) {
        const conflictErr = new Error(`Idempotency conflict for key: ${key}`);
        conflictErr.code = "IDEMPOTENCY_CONFLICT";
        conflictErr.existing = existing;
        throw conflictErr;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const sql = `
      INSERT INTO idempotency_records (
        idempotency_key, task_id, capability_name, logical_operation_id,
        result_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?);
    `;
    const args = [
      key,
      taskId,
      capabilityName,
      logicalOperationId,
      resultRedacted ? JSON.stringify(redactObject(resultRedacted)) : null,
      now,
    ];
    try {
      await executor.execute({ sql, args });
      return this.getIdempotencyRecord(key);
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT" || String(err.message).includes("UNIQUE constraint failed") || String(err.message).includes("PRIMARY KEY")) {
        const raced = await this.getIdempotencyRecord(key);
        if (raced) {
          const newSerialized = resultRedacted ? JSON.stringify(redactObject(resultRedacted)) : null;
          const oldSerialized = raced.result_redacted ? JSON.stringify(raced.result_redacted) : null;
          if (raced.logical_operation_id !== logicalOperationId || (newSerialized && oldSerialized && newSerialized !== oldSerialized)) {
            const conflictErr = new Error(`Idempotency conflict for key: ${key}`);
            conflictErr.code = "IDEMPOTENCY_CONFLICT";
            conflictErr.existing = raced;
            throw conflictErr;
          }
          return raced;
        }
      }
      throw err;
    }
  }

  // ==========================================
  // 8. BUDGET LEDGER
  // ==========================================

  async recordBudgetEntry(entry) {
    const now = new Date().toISOString();
    const entryId = entry.entry_id || `bgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = `
      INSERT INTO budget_ledger (
        entry_id, task_id, type, tool_steps_delta, model_calls_delta,
        retries_delta, tokens_delta, cost_usd_delta, snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      entryId,
      entry.task_id,
      entry.type,
      Number(entry.tool_steps_delta || 0),
      Number(entry.model_calls_delta || 0),
      Number(entry.retries_delta || 0),
      Number(entry.tokens_delta || 0),
      Number(entry.cost_usd_delta || 0.0),
      typeof entry.snapshot === "string" ? entry.snapshot : JSON.stringify(entry.snapshot || {}),
      now,
    ];

    await this.db.execute({ sql, args });
    return entryId;
  }

  async getLatestBudgetSnapshot(taskId) {
    const res = await this.db.execute({
      sql: "SELECT snapshot FROM budget_ledger WHERE task_id = ? ORDER BY rowid DESC LIMIT 1;",
      args: [taskId],
    });
    if (res.rows.length === 0) return null;
    try {
      return JSON.parse(res.rows[0].snapshot);
    } catch {
      return null;
    }
  }

  async getBudgetHistory(taskId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM budget_ledger WHERE task_id = ? ORDER BY created_at ASC;",
      args: [taskId],
    });
    return res.rows.map((row) => ({
      ...row,
      tool_steps_delta: Number(row.tool_steps_delta),
      model_calls_delta: Number(row.model_calls_delta),
      retries_delta: Number(row.retries_delta),
      tokens_delta: Number(row.tokens_delta),
      cost_usd_delta: Number(row.cost_usd_delta),
      snapshot: JSON.parse(row.snapshot),
    }));
  }

  // ==========================================
  // 9. AUDIT EVENTS
  // ==========================================

  async recordAuditEvent({ eventType, taskId = null, jobId = null, actorPn = null, details = {} }) {
    const now = new Date().toISOString();
    const auditId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const redactedDetails = redactObject(details);

    // Sanitasi ekstra: buang raw prompt / CoT / WhatsApp auth
    delete redactedDetails?.prompt;
    delete redactedDetails?.messages;
    delete redactedDetails?.reasoning;
    delete redactedDetails?.cot;
    delete redactedDetails?.credentials;

    const sql = `
      INSERT INTO audit_events (
        audit_id, event_type, task_id, job_id, actor_pn,
        details_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `;
    const args = [
      auditId,
      eventType,
      taskId,
      jobId,
      actorPn,
      JSON.stringify(redactedDetails),
      now,
    ];

    await this.db.execute({ sql, args });
    return auditId;
  }

  async listAuditEvents({ taskId = null, jobId = null, limit = 50 } = {}) {
    const conditions = [];
    const args = [];
    if (taskId) {
      conditions.push("task_id = ?");
      args.push(taskId);
    }
    if (jobId) {
      conditions.push("job_id = ?");
      args.push(jobId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ?;`;
    args.push(limit);

    const res = await this.db.execute({ sql, args });
    return res.rows.map((row) => {
      const parsed = row.details_redacted ? JSON.parse(row.details_redacted) : {};
      return {
        ...row,
        details_redacted: parsed,
        details: parsed,
      };
    });
  }

  // ==========================================
  // 10. WORKER LEASES (FENCING & PROCESS LOCK)
  // ==========================================

  async acquireLease({ resourceType, resourceId, workerId, leaseDurationMs = 30000 }) {
    const nowMs = Date.now();
    const leaseUntil = nowMs + leaseDurationMs;
    const nowIso = new Date().toISOString();

    let tx = null;
    try {
      tx = await this.db.transaction("write");
    } catch (err) {
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return { acquired: false };
      }
      throw err;
    }
    try {
      const curRes = await tx.execute({
        sql: "SELECT * FROM worker_leases WHERE resource_type = ? AND resource_id = ?;",
        args: [resourceType, resourceId],
      });

      if (curRes.rows.length === 0) {
        // Baru: insert lease dengan fencing_token = 1
        await tx.execute({
          sql: `
            INSERT INTO worker_leases (
              resource_type, resource_id, worker_id, lease_until, fencing_token, updated_at
            ) VALUES (?, ?, ?, ?, 1, ?);
          `,
          args: [resourceType, resourceId, workerId, leaseUntil, nowIso],
        });
        await tx.commit();
        return {
          acquired: true,
          fencingToken: 1,
          leaseUntil,
        };
      }

      const current = curRes.rows[0];
      const isExpired = Number(current.lease_until) < nowMs;
      const isSameWorker = current.worker_id === workerId;

      if (!isExpired && !isSameWorker) {
        // Sedang dipegang worker lain dan belum expired
        await tx.rollback();
        return {
          acquired: false,
          currentWorker: current.worker_id,
          leaseUntil: Number(current.lease_until),
          fencingToken: Number(current.fencing_token),
        };
      }

      // Bisa di-takeover atau diperbarui: fencing_token naik 1
      const nextFencingToken = Number(current.fencing_token) + 1;
      const updateRes = await tx.execute({
        sql: `
          UPDATE worker_leases
          SET worker_id = ?, lease_until = ?, fencing_token = ?, updated_at = ?
          WHERE resource_type = ? AND resource_id = ? AND fencing_token = ?;
        `,
        args: [workerId, leaseUntil, nextFencingToken, nowIso, resourceType, resourceId, current.fencing_token],
      });

      if (updateRes.rowsAffected === 0) {
        await tx.rollback();
        return { acquired: false };
      }

      await tx.commit();
      return {
        acquired: true,
        fencingToken: nextFencingToken,
        leaseUntil,
      };
    } catch (err) {
      try { if (tx) await tx.rollback(); } catch {}
      if (err.code === "SQLITE_BUSY" || String(err.message).includes("database is locked")) {
        return { acquired: false };
      }
      throw err;
    }
  }

  async renewLease({ resourceType, resourceId, workerId, fencingToken, leaseDurationMs = 30000 }) {
    const nowMs = Date.now();
    const leaseUntil = nowMs + leaseDurationMs;
    const nowIso = new Date().toISOString();

    const res = await this.db.execute({
      sql: `
        UPDATE worker_leases
        SET lease_until = ?, updated_at = ?
        WHERE resource_type = ? AND resource_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [leaseUntil, nowIso, resourceType, resourceId, workerId, fencingToken],
    });

    return res.rowsAffected > 0;
  }

  async releaseLease({ resourceType, resourceId, workerId, fencingToken }) {
    const res = await this.db.execute({
      sql: `
        DELETE FROM worker_leases
        WHERE resource_type = ? AND resource_id = ? AND worker_id = ? AND fencing_token = ?;
      `,
      args: [resourceType, resourceId, workerId, fencingToken],
    });
    return res.rowsAffected > 0;
  }

  async getExpiredLeases(resourceType, nowMs = Date.now()) {
    const res = await this.db.execute({
      sql: "SELECT * FROM worker_leases WHERE resource_type = ? AND lease_until < ?;",
      args: [resourceType, nowMs],
    });
    return res.rows.map((row) => ({
      ...row,
      lease_until: Number(row.lease_until),
      fencing_token: Number(row.fencing_token),
    }));
  }

  // ==========================================
  // NOTES (MVP CAPABILITY STORAGE)
  // ==========================================

  async createNote({ noteId, chatId, ownerPn, title, content }) {
    if (!chatId || typeof chatId !== "string") {
      throw new Error("chatId wajib non-empty string");
    }
    if (!title || typeof title !== "string") {
      throw new Error("title wajib non-empty string");
    }
    const id = noteId || `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO notes (note_id, chat_id, owner_pn, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `;
    await this.db.execute({
      sql,
      args: [id, chatId, ownerPn || "system", title, content || "", now, now],
    });
    return this.getNote(id);
  }

  async getNote(noteId) {
    const res = await this.db.execute({
      sql: "SELECT * FROM notes WHERE note_id = ?;",
      args: [noteId],
    });
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async listNotes({ chatId, ownerPn, limit = 50 } = {}) {
    const conditions = [];
    const args = [];
    if (chatId) {
      conditions.push("chat_id = ?");
      args.push(chatId);
    }
    if (ownerPn) {
      conditions.push("owner_pn = ?");
      args.push(ownerPn);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT ?;`;
    args.push(limit);
    const res = await this.db.execute({ sql, args });
    return res.rows;
  }

  async deleteNote(noteId) {
    const res = await this.db.execute({
      sql: "DELETE FROM notes WHERE note_id = ?;",
      args: [noteId],
    });
    return res.rowsAffected > 0;
  }
}

module.exports = {
  SqliteStorage,
  OptimisticConcurrencyError,
  LeaseConflictError,
  StaleFencingTokenError,
};
