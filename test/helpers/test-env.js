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
  process.env.STICKER_DIR = path.join(testDir, "stickers");
  process.env.FEATURES_FILE = path.join(testDir, "features.json");
  process.env.RUNTIME_SETTINGS_FILE = path.join(testDir, "runtime-settings.json");
  process.env.DASHBOARD_TOKEN_FILE = path.join(testDir, "dashboard-token");
  process.env.NOTEBOOK_FILE = path.join(testDir, "notebook.json");
  process.env.WORKSPACE_DIR = path.join(testDir, "workspace");
  // Tes tidak boleh memakai key asli dari .env (dotenv tidak menimpa env yang
  // sudah ada). Tes AI memasang key palsu + mock server sendiri.
  process.env.OPENROUTER_API_KEY = "";

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
