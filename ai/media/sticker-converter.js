const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

function convertSticker(buffer, { timeoutMs = 5000, maxOutputBytes = 512 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) return Promise.reject(new Error("sticker_input_size_invalid"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=96", path.join(__dirname, "sticker-worker.js")], {
      cwd: os.tmpdir(), env: { PATH: process.env.PATH || "" }, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("sticker_timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) { child.kill(); finish(new Error("sticker_output_too_large")); return; }
      chunks.push(chunk);
    });
    child.on("error", () => finish(new Error("sticker_worker_error")));
    child.on("close", (code) => {
      if (code !== 0) { finish(new Error("sticker_conversion_failed")); return; }
      const output = Buffer.concat(chunks);
      if (output.length < 12 || output.toString("ascii", 0, 4) !== "RIFF" || output.toString("ascii", 8, 12) !== "WEBP") {
        finish(new Error("sticker_output_invalid")); return;
      }
      finish(null, output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

module.exports = { convertSticker };
