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
const { fork, spawnSync } = require("node:child_process");
const { safeHttpRequest } = require("./safe-http");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// net.get/post memakai run_sync Pyodide yang butuh JSPI (WebAssembly stack
// switching). Node 22 belum mengaktifkannya default, dan nama flag-nya beda
// per versi V8 (Node 20: --experimental-wasm-stack-switching, Node 22:
// --experimental-wasm-jspi). Flag yang tidak dikenal membuat node gagal start,
// jadi dicek sekali ke `node --v8-options` (proses bot, bukan sandbox) lalu
// di-cache. Flag ini hanya fitur WebAssembly; permission model tidak berubah.
let jspiFlagsCache = null;
function jspiFlags() {
  if (jspiFlagsCache) return jspiFlagsCache;
  if (typeof WebAssembly.Suspending === "function") return (jspiFlagsCache = []);
  let options = "";
  try {
    options = spawnSync(process.execPath, ["--v8-options"], { encoding: "utf8", timeout: 10_000, env: {} }).stdout || "";
  } catch {}
  if (/--experimental-wasm-jspi\b/.test(options)) jspiFlagsCache = ["--experimental-wasm-jspi"];
  else if (/--experimental-wasm-stack-switching\b/.test(options)) jspiFlagsCache = ["--experimental-wasm-stack-switching"];
  else jspiFlagsCache = [];
  return jspiFlagsCache;
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
// Dokumen di out/ dikirim sebagai file dokumen WhatsApp.
const DOCUMENT_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  // Kasus 27 Sep: "file isi hati" disimpan .txt lalu diaku terkirim padahal tidak.
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
};

// Paket PyPI murni-Python (diunduh npm run python:setup) dipasang hanya bila
// kode memakainya; pyodide = paket bawaan Pyodide yang dibutuhkan.
const WHEEL_GROUPS = {
  qrcode: { match: /\bqrcode\b/, wheels: ["qrcode"], pyodide: ["pillow"] },
  pypdf: { match: /\bpypdf\b/, wheels: ["pypdf", "typing_extensions"], pyodide: [] },
  docx: { match: /\b(?:import|from)\s+docx\b/, wheels: ["python-docx", "typing_extensions"], pyodide: ["lxml"] },
  pptx: { match: /\b(?:import|from)\s+pptx\b/, wheels: ["python-pptx", "XlsxWriter", "typing_extensions"], pyodide: ["lxml", "pillow"] },
  openpyxl: { match: /\bopenpyxl\b|\.(?:to|read)_excel\b/, wheels: ["openpyxl", "et_xmlfile"], pyodide: [] },
  xlsxwriter: { match: /\bxlsxwriter\b/, wheels: ["XlsxWriter"], pyodide: [] },
  fpdf: { match: /\b(?:import|from)\s+fpdf\b/, wheels: ["fpdf2", "defusedxml"], pyodide: ["pillow", "fonttools"] },
  gradzip: { match: /\bgradzip\b/, wheels: [], pyodide: ["pycryptodome"] },
};

// Modul bantu buatan kita (ai/sandbox/pylib/*.py), dikirim ke worker hanya bila diimpor.
const PYLIB_DIR = path.join(__dirname, "pylib");
function helperModules(code) {
  let names = [];
  try {
    names = fs.readdirSync(PYLIB_DIR).filter((file) => file.endsWith(".py"));
  } catch {
    return {};
  }
  return Object.fromEntries(names
    .filter((file) => new RegExp(`\\b${file.slice(0, -3)}\\b`).test(code))
    .map((file) => [file, fs.readFileSync(path.join(PYLIB_DIR, file), "utf8")]));
}

function readWheelIndex(cfg) {
  const raw = JSON.parse(fs.readFileSync(path.join(cfg.cacheDir, "extra-wheels.json"), "utf8"));
  // Format lama (sebelum dukungan dokumen): daftar file, hanya qrcode.
  return Array.isArray(raw) ? { qrcode: raw.find((file) => file.startsWith("qrcode")) } : raw.wheels || {};
}

// File wheel + paket Pyodide yang perlu dipasang untuk kode ini.
function installPlan(code, cfg) {
  const index = readWheelIndex(cfg);
  const wheels = new Set();
  const pyodide = new Set();
  for (const group of Object.values(WHEEL_GROUPS)) {
    if (!group.match.test(code)) continue;
    for (const name of group.wheels) if (index[name]) wheels.add(index[name]);
    for (const name of group.pyodide) pyodide.add(name);
  }
  return { wheels: [...wheels], pyodide: [...pyodide] };
}

// Dukungan dokumen butuh wheel format baru; setup lama → npm run python:setup lagi.
function documentsReady(cfg = pythonConfig()) {
  if (!isReady(cfg)) return false;
  try {
    const index = readWheelIndex(cfg);
    return ["pypdf", "python-docx", "python-pptx", "openpyxl", "fpdf2"].every((name) => index[name]);
  } catch {
    return false;
  }
}

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
// Worker cadangan per folder kerja (uji 3 Okt: cuaca Nabire 16 dtk, 2 run_python × ±5 dtk
// hanya untuk menyalakan Pyodide). Isolasi sama: satu proses per run, izin fs sama persis;
// cadangan hanya dipakai untuk folder kerja yang sama lalu dibuang, dan mati sendiri.
const WARM_TTL_MS = 2 * 60_000;
const WARM_MAX = 2;
const warmWorkers = new Map(); // workdir -> { child, timer }

function warmEnabled() {
  return String(process.env.PYTHON_WARM_WORKER || "true").trim().toLowerCase() !== "false";
}

function spawnWorker(workdir, cfg, { warm = false } = {}) {
  const pyDir = pyodideDir();
  return fork(path.join(__dirname, "python-worker.js"), warm ? ["--warm", workdir, pyDir, cfg.cacheDir] : [], {
    execArgv: [
      "--permission",
      `--allow-fs-read=${pyDir}`,
      `--allow-fs-read=${cfg.cacheDir}`,
      `--allow-fs-read=${__dirname}`,
      `--allow-fs-read=${workdir}`,
      `--allow-fs-write=${workdir}`,
      `--max-old-space-size=${cfg.memoryMb}`,
      ...jspiFlags(),
    ],
    env: {},
    cwd: workdir,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
}

function dropWarm(workdir) {
  const item = warmWorkers.get(workdir);
  if (!item) return;
  warmWorkers.delete(workdir);
  clearTimeout(item.timer);
  if (!item.child.killed) item.child.kill();
}

function takeWarm(workdir) {
  const item = warmWorkers.get(workdir);
  if (!item) return null;
  warmWorkers.delete(workdir);
  clearTimeout(item.timer);
  return item.child.exitCode === null && !item.child.killed ? item.child : null;
}

function prewarm(workdir, cfg) {
  if (!warmEnabled() || warmWorkers.has(workdir)) return;
  while (warmWorkers.size >= WARM_MAX) dropWarm(warmWorkers.keys().next().value);
  try {
    const child = spawnWorker(workdir, cfg, { warm: true });
    child.stderr?.on("data", () => {});
    child.stderr?.unref?.();
    child.on("error", () => dropWarm(workdir));
    child.on("exit", () => { if (warmWorkers.get(workdir)?.child === child) warmWorkers.delete(workdir); });
    const timer = setTimeout(() => dropWarm(workdir), WARM_TTL_MS);
    timer.unref?.();
    child.unref?.();
    child.channel?.unref?.();
    warmWorkers.set(workdir, { child, timer });
  } catch (error) {
    console.warn("[PYTHON] Worker cadangan gagal disiapkan:", error.message);
  }
}

/** Nyalakan worker cadangan untuk chat ini lebih awal (mis. saat skill ber-Python dimuat). */
function prewarmChat(chatId, cfg = pythonConfig()) {
  if (!isReady(cfg)) return;
  prewarm(workspaceFor(chatId, cfg), cfg);
}

function stopWarmWorkers() {
  for (const workdir of [...warmWorkers.keys()]) dropWarm(workdir);
}

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
  const child = takeWarm(workdir) || spawnWorker(workdir, cfg);
  child.ref?.();
  child.channel?.ref?.();
  let stderrTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2_000); });
  const install = installPlan(source, cfg);
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
    child.send({ type: "run", job: { code: source, pyodideDir: pyDir, cacheDir: cfg.cacheDir, workdir, install, helpers: helperModules(source), maxOutput: cfg.maxOutput } });
  });
  // Chat ini kemungkinan menjalankan Python lagi sebentar lagi (tugas bertahap): siapkan cadangan.
  prewarm(workdir, cfg);

  const changed = fs.readdirSync(outDir)
    .filter((name) => !before.has(name) || fs.statSync(path.join(outDir, name)).mtimeMs > before.get(name))
    .map((name) => ({ name, path: path.join(outDir, name), ext: path.extname(name).toLowerCase(), size: fs.statSync(path.join(outDir, name)).size }))
    .filter((file) => file.size > 0);
  const images = changed
    .filter((file) => IMAGE_TYPES[file.ext] && file.size <= 5 * 1_048_576)
    .map(({ ext, ...file }) => ({ ...file, mime: IMAGE_TYPES[ext] }))
    .slice(0, cfg.maxImages);
  const documents = changed
    .filter((file) => DOCUMENT_TYPES[file.ext] && file.size <= 16 * 1_048_576)
    .map(({ ext, ...file }) => ({ ...file, mime: DOCUMENT_TYPES[ext] }))
    .slice(0, 3);
  // File baru di out/ yang TIDAK ikut terkirim dilaporkan, supaya model tidak mengaku sudah mengirimnya.
  const sent = new Set([...images, ...documents].map((file) => file.name));
  const notSent = changed.filter((file) => !sent.has(file.name)).map((file) => ({
    name: file.name,
    reason: !IMAGE_TYPES[file.ext] && !DOCUMENT_TYPES[file.ext] ? `format ${file.ext || "tanpa ekstensi"} tidak dikirim`
      : file.size > (IMAGE_TYPES[file.ext] ? 5 : 16) * 1_048_576 ? "terlalu besar" : "melebihi jumlah file per run",
  }));
  return { ...result, images, documents, notSent, files: listFiles(workdir), requests, durationMs: Date.now() - started };
}

module.exports = { DOCUMENT_TYPES, WHEEL_GROUPS, documentsReady, installPlan, isReady, pythonConfig, prewarmChat, runPython, stopWarmWorkers, warmCount: () => warmWorkers.size, workspaceFor };
