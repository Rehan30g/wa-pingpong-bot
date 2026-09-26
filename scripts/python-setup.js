// Siapkan paket Python untuk sandbox run_python (Pyodide). Sandbox tidak punya
// akses jaringan, jadi paket diunduh sekali di sini ke cache lokal:
//   npm run python:setup
const fs = require("node:fs");
const path = require("node:path");
const { pythonConfig } = require("../ai/sandbox/python-runner");

const PACKAGES = ["micropip", "numpy", "pandas", "matplotlib", "pillow", "sympy", "requests"];
// Paket murni-Python dari PyPI yang tidak ada di distribusi Pyodide.
const PYPI_WHEELS = ["qrcode"];

async function pypiWheel(name, dir) {
  const response = await fetch(`https://pypi.org/pypi/${name}/json`);
  if (!response.ok) throw new Error(`PyPI ${name}: HTTP ${response.status}`);
  const info = await response.json();
  const wheel = info.urls.find((file) => file.packagetype === "bdist_wheel" && /-py3-none-any\.whl$/.test(file.filename));
  if (!wheel) throw new Error(`${name}: tidak ada wheel py3-none-any`);
  const target = path.join(dir, wheel.filename);
  if (!fs.existsSync(target)) fs.writeFileSync(target, Buffer.from(await (await fetch(wheel.url)).arrayBuffer()));
  return wheel.filename;
}

(async () => {
  const cfg = pythonConfig();
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  const { loadPyodide } = await import("pyodide");
  console.log(`[python] Mengunduh paket ke ${cfg.cacheDir} …`);
  const pyodide = await loadPyodide({ packageCacheDir: cfg.cacheDir });
  for (const name of PACKAGES) {
    for (let attempt = 1; ; attempt += 1) {
      let failed = null;
      await pyodide.loadPackage(name, { messageCallback: () => {}, errorCallback: (message) => { failed = message; } });
      const importName = { pillow: "PIL" }[name] || name;
      try {
        pyodide.runPython(`import ${importName}`);
        if (!failed) break;
      } catch (error) {
        failed = failed || error.message;
      }
      if (attempt >= 3) throw new Error(`${name}: ${String(failed).slice(0, 200)}`);
      console.log(`[python] ${name} gagal (${String(failed).slice(0, 80)}), mencoba lagi…`);
    }
  }
  const wheels = [];
  for (const name of PYPI_WHEELS) wheels.push(await pypiWheel(name, cfg.cacheDir));
  fs.writeFileSync(path.join(cfg.cacheDir, "extra-wheels.json"), JSON.stringify(wheels, null, 2));
  console.log(`[python] Siap: ${PACKAGES.join(", ")} + ${wheels.join(", ")}`);
  process.exit(0);
})().catch((error) => {
  console.error("[python] Setup gagal:", error.message);
  process.exit(1);
});
