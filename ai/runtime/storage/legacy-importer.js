/**
 * Legacy JSON Importer (Idempotent) untuk Runtime Durable (Fase 2)
 *
 * Mengimpor job dari agent-jobs.json ke dalam tabel SQLite `jobs`.
 * File JSON lama TIDAK PERNAH dihapus atau diubah.
 * Impor bersifat idempotent: job yang sudah ada tidak diduplikasi.
 */

const fs = require("node:fs");
const path = require("node:path");

async function importLegacyJobs(storage, jobsFilePath = process.env.AGENT_JOBS_FILE || "./agent-jobs.json") {
  const resolved = path.resolve(jobsFilePath);
  if (!fs.existsSync(resolved)) {
    return { importedCount: 0, skippedCount: 0 };
  }

  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(`Gagal membaca file jobs legacy ${resolved}: ${err.message}`);
  }

  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  let importedCount = 0;
  let skippedCount = 0;

  for (const job of jobs) {
    const existing = await storage.getJob(job.id);
    if (existing) {
      skippedCount += 1;
      continue;
    }

    await storage.createJob({
      job_id: job.id,
      type: job.type || "reminder",
      fire_at: Number(job.fire_at),
      payload: job.payload || {},
      status: "scheduled",
      attempts: Number(job.attempts || 0),
      created_at: job.created_at ? new Date(job.created_at).toISOString() : new Date().toISOString(),
    });
    importedCount += 1;
  }

  return {
    totalLegacyJobs: jobs.length,
    importedCount,
    skippedCount,
  };
}

module.exports = {
  importLegacyJobs,
};
