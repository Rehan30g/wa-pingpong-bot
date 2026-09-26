const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function setupIsolatedTestEnv(prefix = "wa-test-") {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const memoryFile = path.join(testDir, "ai-memory.json");
  const jobsFile = path.join(testDir, "agent-jobs.json");
  const dataFile = path.join(testDir, "data.json");
  const runtimeDb = path.join(testDir, "runtime.db");

  process.env.AI_MEMORY_FILE = memoryFile;
  process.env.AGENT_JOBS_FILE = jobsFile;
  process.env.BOT_DATA_FILE = dataFile;
  process.env.RUNTIME_DB_PATH = runtimeDb;

  function cleanup() {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  }

  return { testDir, memoryFile, jobsFile, dataFile, runtimeDb, cleanup };
}

module.exports = {
  setupIsolatedTestEnv,
};
