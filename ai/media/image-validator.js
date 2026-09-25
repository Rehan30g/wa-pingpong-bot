const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

function validateImage(buffer, { timeoutMs = 5000 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) return Promise.reject(new Error("image_size_invalid"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=96", path.join(__dirname, "image-validator-worker.js")], {
      cwd: os.tmpdir(), env: { PATH: process.env.PATH || "" }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("image_validation_timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512) { child.kill(); finish(new Error("image_validation_output_limit")); return; }
      chunks.push(chunk);
    });
    child.on("error", () => finish(new Error("image_validation_worker_error")));
    child.on("close", (code) => {
      if (code !== 0) { finish(new Error("image_decode_invalid")); return; }
      try {
        const info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!["image/jpeg", "image/png", "image/webp"].includes(info.mime) || !Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1 || info.width * info.height > 16_000_000) throw new Error("image_decode_invalid");
        finish(null, info);
      } catch { finish(new Error("image_decode_invalid")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

module.exports = { validateImage };
