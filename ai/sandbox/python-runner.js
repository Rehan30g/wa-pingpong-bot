// Sandbox Python ringan tanpa Docker (Plan v2 M4b): Pyodide (Python di
// WebAssembly) di child process Node dengan permission model. Lapisan keamanan:
//  1. env kosong (tidak ada API key), folder kerja per chat;
//  2. --permission: baca hanya Pyodide/cache/folder kerja, tulis hanya folder
//     kerja, tanpa jaringan dan tanpa menjalankan program lain;
//  3. modul Python `js` hanya melihat objek kosong;
//  4. internet hanya lewat jembatan ke proses bot → safeHttpRequest (anti SSRF);
//  5. batas waktu, memori, jumlah request, dan ukuran output.
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { safeHttpRequest } = require("./safe-http");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function pythonConfig() {
  return {
    cacheDir: path.resolve(process.env.PYTHON_CACHE_DIR || "./data/pyodide-cache"),
    workspaceRoot: path.resolve(process.env.WORKSPACE_DIR || "./data/workspace"),
    timeoutMs: Math.max(5_000, envNumber("PYTHON_TIMEOUT_MS", 60_000)),
    memoryMb: Math.max(128, envNumber("PYTHON_MEMORY_MB", 768)),
    maxOutput: 8_000,
    maxRequests: Math.max(0, envNumber("PYTHON_MAX_REQUESTS", 20)),
    maxWorkspaceMb: Math.max(1, envNumber("WORKSPACE_MAX_MB", 50)),
    maxImages: 4,
  };
}

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function pyodideDir() {
  return path.dirname(require.resolve("pyodide/package.json"));
}

function isReady(cfg = pythonConfig()) {
  return fs.existsSync(path.join(cfg.cacheDir, "extra-wheels.json"));
}

// Folder kerja per chat; nama dari JID yang disaring supaya tidak bisa keluar folder.
function workspaceFor(chatId, cfg = pythonConfig()) {
  const safe = String(chatId || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
  const dir = path.join(cfg.workspaceRoot, safe);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  return dir;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files.slice(0, 100);
}

/**
 * Jalankan kode Python di folder kerja chat. Gambar yang disimpan ke `out/`
 * dikembalikan di `images` untuk dikirim ke chat asal.
 */
async function runPython({ chatId, code, cfg = pythonConfig(), requester = safeHttpRequest }) {
  if (!isReady(cfg)) return { ok: false, error: "sandbox Python belum disiapkan (owner: npm run python:setup)" };
  const source = String(code || "");
  if (!source.trim()) return { ok: false, error: "kode kosong" };
  if (source.length > 20_000) return { ok: false, error: "kode terlalu panjang" };
  const workdir = workspaceFor(chatId, cfg);
  if (dirSize(workdir) > cfg.maxWorkspaceMb * 1_048_576) return { ok: false, error: `workspace chat ini penuh (> ${cfg.maxWorkspaceMb} MB)` };
  // Hanya file out/ yang baru/berubah di run ini yang dikirim; hasil lama (juga
  // milik media_edit di tugas yang sama) tidak dihapus. File out/ > 1 hari dibersihkan.
  const outDir = path.join(workdir, "out");
  const before = new Map();
  for (const name of fs.readdirSync(outDir)) {
    const stat = fs.statSync(path.join(outDir, name));
    if (Date.now() - stat.mtimeMs > 86_400_000) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    else before.set(name, stat.mtimeMs);
  }

  const pyDir = pyodideDir();
  const child = fork(path.join(__dirname, "python-worker.js"), [], {
    execArgv: [
      "--permission",
      `--allow-fs-read=${pyDir}`,
      `--allow-fs-read=${cfg.cacheDir}`,
      `--allow-fs-read=${__dirname}`,
      `--allow-fs-read=${workdir}`,
      `--allow-fs-write=${workdir}`,
      `--max-old-space-size=${cfg.memoryMb}`,
    ],
    env: {},
    cwd: workdir,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2_000); });
  const extraWheels = JSON.parse(fs.readFileSync(path.join(cfg.cacheDir, "extra-wheels.json"), "utf8"));
  let requests = 0;
  const started = Date.now();

  const result = await new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `waktu habis (${Math.round(cfg.timeoutMs / 1000)} detik)` }), cfg.timeoutMs);
    child.on("message", async (message) => {
      if (message?.type === "done") return finish(message.result || { ok: false, error: "hasil kosong" });
      if (message?.type !== "http") return;
      let response;
      if (++requests > cfg.maxRequests) {
        response = { error: `batas ${cfg.maxRequests} request per run` };
      } else {
        try {
          const req = message.request || {};
          const res = await requester({ url: req.url, method: req.method, headers: req.headers, body: req.body });
          response = { status: res.status, url: res.url, headers: res.headers, body: res.body.toString("base64"), error: null };
        } catch (error) {
          response = { status: 0, url: String(message.request?.url || ""), headers: {}, body: "", error: String(error.message || error) };
        }
      }
      if (!finished) child.send({ type: "http_result", id: message.id, response });
    });
    child.on("exit", (codeValue) => finish({ ok: false, error: `sandbox berhenti (kode ${codeValue})${stderrTail ? `: ${stderrTail.split("\n").filter(Boolean).slice(-2).join(" ")}` : ""}` }));
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.send({ type: "run", job: { code: source, pyodideDir: pyDir, cacheDir: cfg.cacheDir, workdir, extraWheels, maxOutput: cfg.maxOutput } });
  });

  const images = fs.readdirSync(outDir)
    .filter((name) => IMAGE_TYPES[path.extname(name).toLowerCase()])
    .filter((name) => !before.has(name) || fs.statSync(path.join(outDir, name)).mtimeMs > before.get(name))
    .map((name) => ({ name, path: path.join(outDir, name), mime: IMAGE_TYPES[path.extname(name).toLowerCase()], size: fs.statSync(path.join(outDir, name)).size }))
    .filter((image) => image.size > 0 && image.size <= 5 * 1_048_576)
    .slice(0, cfg.maxImages);
  return { ...result, images, files: listFiles(workdir), requests, durationMs: Date.now() - started };
}

module.exports = { isReady, pythonConfig, runPython, workspaceFor };
