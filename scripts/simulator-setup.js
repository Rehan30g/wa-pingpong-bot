const fs = require("fs");
const path = require("path");
const os = require("os");

function setupSimulatorEnv() {
  const prodMemoryPath = path.resolve("./ai-memory.json");
  const prodJobsPath = path.resolve("./agent-jobs.json");

  let tempDir = null;
  if (!process.env.AI_MEMORY_FILE || !process.env.AGENT_JOBS_FILE) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sim-"));
    if (!process.env.AI_MEMORY_FILE) {
      process.env.AI_MEMORY_FILE = path.join(tempDir, "sim-ai-memory.json");
    }
    if (!process.env.AGENT_JOBS_FILE) {
      process.env.AGENT_JOBS_FILE = path.join(tempDir, "sim-agent-jobs.json");
    }
  }

  const resolvedMemory = path.resolve(process.env.AI_MEMORY_FILE);
  const resolvedJobs = path.resolve(process.env.AGENT_JOBS_FILE);
  const allowProd = process.env.ALLOW_PRODUCTION_SIMULATION === "true";

  if ((resolvedMemory === prodMemoryPath || resolvedJobs === prodJobsPath) && !allowProd) {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
    throw new Error(
      `[SIMULATOR GUARD] DITOLAK: Simulator terdeteksi mengarah ke file produksi (${resolvedMemory} atau ${resolvedJobs}). Gunakan direktori terisolasi atau set ALLOW_PRODUCTION_SIMULATION=true jika benar-benar disengaja.`,
    );
  }

  function cleanup() {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  return { tempDir, cleanup };
}

module.exports = {
  setupSimulatorEnv,
};
