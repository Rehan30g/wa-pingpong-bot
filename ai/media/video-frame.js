const { spawn } = require("node:child_process");

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

function extractVideoFrame(buffer, { spawnProcess = spawn, timeoutMs = 5000, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const chunks = [];
    let size = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && !child.killed) child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawnProcess("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0",
        "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      child.on("error", () => finish(null));
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxFrameBytes) return finish(null);
        chunks.push(chunk);
      });
      child.on("close", (code) => {
        const frame = Buffer.concat(chunks);
        finish(code === 0 && frame.length > 4 && frame[0] === 0xff && frame[1] === 0xd8 ? frame : null);
      });
      child.stdin.on("error", () => finish(null));
      child.stdin.end(buffer);
    } catch {
      finish(null);
    }
  });
}

module.exports = { extractVideoFrame, MAX_FRAME_BYTES };
