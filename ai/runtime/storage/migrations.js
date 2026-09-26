/**
 * Migrasi skema SQLite transaksional & idempotent untuk Runtime Durable (Fase 2)
 */

const CURRENT_SCHEMA_VERSION = 3;

const MIGRATIONS = [
  {
    version: 1,
    description: "Inisialisasi tabel inti runtime durable Fase 2",
    up: async (tx) => {
      // 1. tasks: state machine tugas, otorisasi, budget, dan concurrency version
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          acceptance_criteria TEXT,
          actor_pn TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          source_event_id TEXT,
          scope TEXT NOT NULL,
          authorization_ref TEXT,
          context_epoch INTEGER NOT NULL DEFAULT 0,
          plan_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          budget_snapshot TEXT,
          evidence_refs TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          worker_id TEXT,
          lease_until INTEGER,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          risk_level TEXT NOT NULL DEFAULT 'low',
          provenance TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      `);
      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_tasks_chat_id ON tasks(chat_id);
      `);
      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_tasks_actor_pn ON tasks(actor_pn);
      `);

      // 1b. notes: penyimpanan catatan terisolasi per chat untuk MVP capability
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS notes (
          note_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          owner_pn TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_notes_chat_id ON notes(chat_id);
      `);

      // 2. task_steps: jejak langkah eksekusi task berurut
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS task_steps (
          step_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          capability_name TEXT NOT NULL,
          logical_operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          input_redacted TEXT,
          observation_redacted TEXT,
          evidence TEXT,
          error_code TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_task_steps_task_id ON task_steps(task_id);
      `);

      // 3. inbox_events: deduplikasi event berdasarkan transport + chat + participant PN + source event ID
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS inbox_events (
          event_id TEXT PRIMARY KEY,
          transport TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          participant_pn TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          payload_redacted TEXT,
          context_epoch INTEGER NOT NULL DEFAULT 0,
          processed_at TEXT,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_inbox_dedup UNIQUE (transport, chat_id, participant_pn, source_event_id)
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_inbox_dedup ON inbox_events(transport, chat_id, participant_pn, source_event_id);
      `);

      // 4. jobs: scheduler durable menggantikan JSON pop-before-run
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          fire_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          worker_id TEXT,
          lease_until INTEGER,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          context_epoch INTEGER NOT NULL DEFAULT 0,
          is_late INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_jobs_fire_at_status ON jobs(fire_at, status);
      `);
      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      `);

      // 5. approvals: persetujuan sensitif terikat actor PN, task, cap, args hash, expiry, single-use
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          actor_pn TEXT NOT NULL,
          capability_name TEXT NOT NULL,
          logical_operation_id TEXT NOT NULL,
          args_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          used_at TEXT
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_approvals_lookup ON approvals(task_id, actor_pn, capability_name, status);
      `);

      // 6. outbox: transactional outbox dengan idempotency key dan status uncertain
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS outbox (
          outbox_id TEXT PRIMARY KEY,
          task_id TEXT,
          job_id TEXT,
          destination TEXT NOT NULL,
          content_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          context_epoch INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          transport_message_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          worker_id TEXT,
          lease_until INTEGER,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          delivery_receipt TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
      `);

      // 7. idempotency_records: mencegah logical operation yang sama dieksekusi 2 kali
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS idempotency_records (
          idempotency_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          capability_name TEXT NOT NULL,
          logical_operation_id TEXT NOT NULL,
          result_redacted TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 8. budget_ledger: rekaman append-only penggunaan token, cost, tool steps, dan retries
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS budget_ledger (
          entry_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          type TEXT NOT NULL,
          tool_steps_delta INTEGER NOT NULL DEFAULT 0,
          model_calls_delta INTEGER NOT NULL DEFAULT 0,
          retries_delta INTEGER NOT NULL DEFAULT 0,
          tokens_delta INTEGER NOT NULL DEFAULT 0,
          cost_usd_delta REAL NOT NULL DEFAULT 0.0,
          snapshot TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_budget_ledger_task_id ON budget_ledger(task_id);
      `);

      // 9. audit_events: jejak audit tersanitasi append-only
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS audit_events (
          audit_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          task_id TEXT,
          job_id TEXT,
          actor_pn TEXT,
          details_redacted TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events(task_id);
      `);

      // 10. worker_leases: fencing dan lease klaim resource (task, job, outbox, process_lock)
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS worker_leases (
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          lease_until INTEGER NOT NULL,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (resource_type, resource_id)
        );
      `);

      // 11. chat_context_epochs: persistensi context epoch per chat
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS chat_context_epochs (
          chat_id TEXT PRIMARY KEY,
          context_epoch INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
      await tx.execute(`
        CREATE INDEX IF NOT EXISTS idx_chat_context_epochs_chat_id ON chat_context_epochs(chat_id);
      `);
    },
  },
  {
    version: 2,
    description: "Kuota egress persisten per task dan per host",
    up: async (tx) => {
      await tx.execute(`CREATE TABLE IF NOT EXISTS egress_task_usage (
        task_id TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0
      );`);
      await tx.execute(`CREATE TABLE IF NOT EXISTS egress_host_hits (
        hit_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        at_ms INTEGER NOT NULL
      );`);
      await tx.execute("CREATE INDEX IF NOT EXISTS idx_egress_host_time ON egress_host_hits(host, at_ms);");
    },
  },
  {
    version: 3,
    description: "Fakta memori bersumber dan terikat chat",
    up: async (tx) => {
      await tx.execute(`CREATE TABLE IF NOT EXISTS memory_facts (
        memory_id TEXT PRIMARY KEY,
        subject_pn TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_entry_id TEXT NOT NULL,
        fact_text TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        occurred_at TEXT,
        recorded_at TEXT NOT NULL,
        expires_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        conflict_key TEXT,
        topic_key TEXT,
        context_epoch INTEGER NOT NULL DEFAULT 0
      );`);
      await tx.execute("CREATE INDEX IF NOT EXISTS idx_memory_facts_scope ON memory_facts(source_chat_id, status, expires_at);");
      await tx.execute("CREATE INDEX IF NOT EXISTS idx_memory_facts_subject ON memory_facts(subject_pn, source_chat_id);");
      await tx.execute("CREATE INDEX IF NOT EXISTS idx_memory_facts_topic ON memory_facts(source_chat_id, subject_pn, topic_key, status);");
      await tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_facts_source_once ON memory_facts(source_chat_id, source_entry_id, subject_pn);");
    },
  },
];

/**
 * Menjalankan migrasi database secara transaksional dan idempotent
 */
async function runMigrations(db) {
  // Pastikan tabel schema_version ada
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // Pastikan tabel chat_context_epochs ada secara idempotent
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chat_context_epochs (
      chat_id TEXT PRIMARY KEY,
      context_epoch INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_chat_context_epochs_chat_id ON chat_context_epochs(chat_id);
  `);

  const currentVersionRes = await db.execute(`
    SELECT COALESCE(MAX(version), 0) AS current_version FROM schema_version;
  `);
  const currentVersion = Number(currentVersionRes.rows[0]?.current_version || 0);

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    return { currentVersion, appliedCount: 0 };
  }

  let appliedCount = 0;
  for (const migration of pending) {
    const tx = await db.transaction("write");
    try {
      await migration.up(tx);
      await tx.execute({
        sql: "INSERT INTO schema_version (version, applied_at) VALUES (?, ?);",
        args: [migration.version, new Date().toISOString()],
      });
      await tx.commit();
      appliedCount += 1;
    } catch (err) {
      await tx.rollback();
      throw new Error(`Migrasi ke versi ${migration.version} gagal: ${err.message}`);
    }
  }

  const finalRes = await db.execute(`
    SELECT COALESCE(MAX(version), 0) AS current_version FROM schema_version;
  `);
  return {
    currentVersion: Number(finalRes.rows[0]?.current_version || 0),
    appliedCount,
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
};
