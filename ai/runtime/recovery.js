/**
 * Startup Recovery untuk Runtime Durable (Fase 2)
 *
 * Menjalankan urutan pemulihan saat proses bot dimulai:
 * 1. Migrasi skema (idempotent).
 * 2. Pemulihan lease yang kedaluwarsa (task & job 'running' yang terputus diubah menjadi 'retry_wait').
 * 3. Rekonsiliasi outbox: pesan 'sending' dengan lease kedaluwarsa diubah menjadi 'uncertain'
 *    (mencegah blind resend yang bisa menyebabkan duplikasi pengiriman pesan WhatsApp!).
 * 4. Pengecekan kesiapan transport: klaim tugas/pesan tidak boleh dimulai sebelum transport WhatsApp siap.
 */

const { runMigrations } = require("./storage/migrations");

async function runStartupRecovery(storage, { isTransportReady = () => true, nowMs = Date.now() } = {}) {
  const db = storage.db;
  const nowIso = new Date().toISOString();

  // 1. Jalankan migrasi idempotent
  const migrationResult = await runMigrations(db);

  // 2. Pulihkan task dengan lease kedaluwarsa (mis. crash saat status 'running')
  const taskRecovery = await db.execute({
    sql: `
      UPDATE tasks
      SET status = 'retry_wait',
          worker_id = NULL,
          lease_until = NULL,
          updated_at = ?
      WHERE status IN ('running', 'verifying')
        AND lease_until IS NOT NULL
        AND lease_until < ?;
    `,
    args: [nowIso, nowMs],
  });

  // 3. Pulihkan job dengan lease kedaluwarsa
  const jobRecovery = await db.execute({
    sql: `
      UPDATE jobs
      SET status = 'retry_wait',
          worker_id = NULL,
          lease_until = NULL,
          updated_at = ?
      WHERE status IN ('claimed', 'running')
        AND lease_until IS NOT NULL
        AND lease_until < ?;
    `,
    args: [nowIso, nowMs],
  });

  // 4a. Pulihkan outbox 'claimed' dengan lease kedaluwarsa -> kembalikan ke 'pending' dengan fencing token dinaikkan
  // Karena transport BELUM dipanggil saat crash, pesan ini aman untuk di-claim ulang!
  const outboxClaimedRecovery = await db.execute({
    sql: `
      UPDATE outbox
      SET status = 'pending',
          worker_id = NULL,
          lease_until = NULL,
          fencing_token = fencing_token + 1,
          updated_at = ?
      WHERE status = 'claimed'
        AND lease_until IS NOT NULL
        AND lease_until < ?;
    `,
    args: [nowIso, nowMs],
  });

  // 4b. Rekonsiliasi outbox 'sending' yang terputus sebelum commit -> delivery_uncertain!
  // SANGAT KRUSIAL: Jangan pernah melakukan blind resend pada pesan yang statusnya sending saat crash!
  const outboxUncertain = await db.execute({
    sql: `
      UPDATE outbox
      SET status = 'uncertain',
          worker_id = NULL,
          lease_until = NULL,
          error_message = 'Recovery startup: proses crash saat pesan dalam status sending. Verifikasi diperlukan sebelum resend.',
          updated_at = ?
      WHERE status = 'sending'
        AND lease_until IS NOT NULL
        AND lease_until < ?;
    `,
    args: [nowIso, nowMs],
  });

  // Reconcile crash window: outbox sudah terminal tetapi status task asset belum diperbarui.
  const assetOutboxes = await db.execute("SELECT outbox_id FROM outbox WHERE content_type IN ('image', 'sticker') AND status IN ('delivered', 'uncertain', 'failed', 'cancelled');");
  let settledAssetTasks = 0;
  for (const item of assetOutboxes.rows) {
    if (await storage.settleAssetTaskFromOutbox(item.outbox_id)) settledAssetTasks++;
  }

  // 5. Verifikasi transport readiness
  const transportReady = Boolean(isTransportReady());

  return {
    migrationResult,
    recoveredTasks: taskRecovery.rowsAffected || 0,
    recoveredJobs: jobRecovery.rowsAffected || 0,
    recoveredClaimedOutbox: outboxClaimedRecovery.rowsAffected || 0,
    reconciledOutbox: outboxUncertain.rowsAffected || 0,
    settledAssetTasks,
    transportReady,
  };
}

module.exports = {
  runStartupRecovery,
};
