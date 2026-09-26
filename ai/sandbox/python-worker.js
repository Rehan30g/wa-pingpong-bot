// Worker sandbox Python (M4b). Dijalankan python-runner.js sebagai child process
// dengan permission model Node: hanya boleh membaca Pyodide + cache paket +
// folder kerja, hanya boleh menulis folder kerja, tanpa jaringan, tanpa
// menjalankan program lain, dan env kosong (tidak ada API key). Satu-satunya
// jalan ke internet adalah jembatan `grad_bridge.request` → proses bot (disaring).
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Emscripten (NODEFS) memanggil process.binding("constants"), yang ditolak
// permission model. Konstanta publik fs/os sudah cukup untuk kebutuhannya.
const originalBinding = process.binding;
process.binding = (name) => (name === "constants"
  ? { fs: fs.constants, os: require("node:os").constants }
  : originalBinding.call(process, name));

let requestSeq = 0;
const pending = new Map();

process.on("message", (message) => {
  if (message?.type === "http_result" && pending.has(message.id)) {
    const { resolve } = pending.get(message.id);
    pending.delete(message.id);
    resolve(message.response);
  } else if (message?.type === "run") {
    run(message.job).then(
      (result) => { process.send({ type: "done", result }); setImmediate(() => process.exit(0)); },
      (error) => { process.send({ type: "done", result: { ok: false, error: String(error?.message || error).slice(0, 2_000) } }); setImmediate(() => process.exit(0)); },
    );
  }
});

function bridgeRequest(json) {
  const id = ++requestSeq;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    process.send({ type: "http", id, request: JSON.parse(String(json)) });
  });
}

// Modul Python `net`: net.get/post/request mengembalikan Response mirip requests.
const PRELUDE = `
import os, sys, json as _json, base64 as _b64
os.environ.pop("_", None)
os.environ["MPLBACKEND"] = "Agg"
import grad_bridge as _bridge
try:
    from pyodide.ffi import run_sync as _run_sync
except Exception:
    _run_sync = None

class Response:
    def __init__(self, data):
        self.status_code = data.get("status", 0)
        self.url = data.get("url", "")
        self.headers = dict(data.get("headers") or {})
        self.content = _b64.b64decode(data.get("body") or "")
        err = data.get("error")
        self.error = err if isinstance(err, str) and err else None
        self.encoding = "utf-8"
    @property
    def ok(self):
        return self.error is None and 200 <= self.status_code < 400
    @property
    def text(self):
        return self.content.decode(self.encoding or "utf-8", errors="replace")
    def json(self):
        return _json.loads(self.text)
    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.error or f"HTTP {self.status_code}")
    def __repr__(self):
        return f"<Response [{self.status_code}]>"

class _Net:
    async def request_async(self, method, url, params=None, json=None, data=None, headers=None):
        if params:
            from urllib.parse import urlencode
            url = url + ("&" if "?" in url else "?") + urlencode(params)
        hdrs = dict(headers or {})
        body = None
        if json is not None:
            body = _json.dumps(json)
            hdrs.setdefault("Content-Type", "application/json")
        elif data is not None:
            if isinstance(data, dict):
                from urllib.parse import urlencode
                body = urlencode(data)
                hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
            else:
                body = data if isinstance(data, str) else bytes(data).decode("latin-1")
        payload = {"url": url, "method": method, "headers": hdrs, "body": body}
        result = await _bridge.request(_json.dumps(payload))
        return Response(result.to_py() if hasattr(result, "to_py") else dict(result))
    def request(self, method, url, **kwargs):
        if _run_sync is None:
            raise RuntimeError("pakai: await net.request_async(...)")
        return _run_sync(self.request_async(method, url, **kwargs))
    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)
    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

net = _Net()
sys.modules["net"] = net
`;

async function run(job) {
  const { loadPyodide } = await import(pathToFileURL(path.join(job.pyodideDir, "pyodide.mjs")).href);
  let stdout = "";
  let stderr = "";
  const cap = (current, text) => (current.length < job.maxOutput ? current + text : current);
  const pyodide = await loadPyodide({
    indexURL: job.pyodideDir,
    packageCacheDir: job.cacheDir,
    // Modul Python `js` hanya melihat objek kosong, bukan global Node.
    jsglobals: Object.create(null),
    env: { HOME: "/home/pyodide" },
    stdout: (text) => { stdout = cap(stdout, `${text}\n`); },
    stderr: (text) => { stderr = cap(stderr, `${text}\n`); },
  });
  pyodide.registerJsModule("grad_bridge", { request: (json) => bridgeRequest(json) });
  pyodide.FS.mkdirTree("/work");
  pyodide.mountNodeFS("/work", job.workdir);
  await pyodide.loadPackage("micropip", { messageCallback: () => {} });
  await pyodide.loadPackagesFromImports(job.code, { messageCallback: () => {} });
  if (/\bqrcode\b/.test(job.code)) {
    await pyodide.loadPackage("pillow", { messageCallback: () => {} });
    for (const wheel of job.extraWheels || []) {
      const bytes = fs.readFileSync(path.join(job.cacheDir, wheel));
      pyodide.FS.writeFile(`/tmp/${wheel}`, bytes);
      await pyodide.runPythonAsync(`import micropip\nawait micropip.install("emfs:/tmp/${wheel}", deps=False)`);
    }
  }
  await pyodide.runPythonAsync(PRELUDE);
  pyodide.runPython('import os; os.makedirs("/work/out", exist_ok=True); os.chdir("/work")');
  let result = null;
  try {
    const value = await pyodide.runPythonAsync(job.code);
    if (value !== undefined && value !== null) {
      // Nilai primitif JS dikembalikan dalam ejaan Python (True/False).
      result = (typeof value === "boolean" ? (value ? "True" : "False") : String(value?.toString?.() ?? value)).slice(0, 2_000);
      value?.destroy?.();
    }
  } catch (error) {
    // Traceback Python cukup baris terakhir yang relevan.
    const message = String(error?.message || error);
    return { ok: false, stdout, stderr, error: message.split("\n").filter((line) => !line.includes("/lib/python3")).slice(-8).join("\n").slice(0, 2_000) };
  }
  return { ok: true, stdout, stderr, result };
}
