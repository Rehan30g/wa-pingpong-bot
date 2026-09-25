const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { constants } = require("node:fs");

async function readRegular(file, maxBytes) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("asset_integrity_invalid");
    return { buffer: await handle.readFile(), size: stat.size };
  } finally {
    await handle.close();
  }
}

class AssetStore {
  constructor({ root = path.join(os.tmpdir(), "grad-agent-assets"), ttlMs = 24 * 60 * 60 * 1000, maxBytes = 20 * 1024 * 1024 } = {}) {
    this.root = path.resolve(root);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
  }

  async put(buffer, { chatId, taskId, mime }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > this.maxBytes) throw new Error("asset_size_invalid");
    if (!chatId || !taskId || !/^(image\/(jpeg|png|webp)|video\/mp4)$/.test(String(mime))) throw new Error("asset_scope_or_mime_invalid");
    const assetId = `asset_${crypto.randomUUID().replace(/-/g, "")}`;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("asset_root_invalid");
    if (process.platform !== "win32") await fs.chmod(this.root, 0o700);
    const file = path.join(this.root, assetId);
    const metaFile = `${file}.json`;
    const meta = { assetId, chatId, taskId, mime, size: buffer.length, createdAt: Date.now(), sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
    await fs.writeFile(file, buffer, { flag: "wx", mode: 0o600 });
    try {
      await fs.writeFile(metaFile, JSON.stringify(meta), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await fs.unlink(file);
      throw error;
    }
    return { assetId, mime, size: meta.size, sha256: meta.sha256 };
  }

  async read(assetId, { chatId, taskId }) {
    if (!/^asset_[a-f0-9]{32}$/.test(String(assetId))) throw new Error("asset_id_invalid");
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("asset_root_invalid");
    const file = path.join(this.root, assetId);
    const meta = JSON.parse((await readRegular(`${file}.json`, 4096)).buffer.toString("utf8"));
    if (meta.chatId !== chatId || meta.taskId !== taskId) throw new Error("asset_scope_denied");
    if (Date.now() - meta.createdAt > this.ttlMs) throw new Error("asset_expired");
    const { buffer, size } = await readRegular(file, this.maxBytes);
    if (size !== meta.size) throw new Error("asset_integrity_invalid");
    if (crypto.createHash("sha256").update(buffer).digest("hex") !== meta.sha256) throw new Error("asset_integrity_invalid");
    return { buffer, mime: meta.mime };
  }

  async cleanup(now = Date.now()) {
    let removed = 0;
    let names;
    try { names = await fs.readdir(this.root); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
    for (const name of names) {
      if (!/^asset_[a-f0-9]{32}\.json$/.test(name)) continue;
      const metaFile = path.join(this.root, name);
      let meta;
      try { meta = JSON.parse((await readRegular(metaFile, 4096)).buffer.toString("utf8")); } catch { continue; }
      if (now - meta.createdAt <= this.ttlMs) continue;
      const assetId = name.slice(0, -5);
      await fs.unlink(path.join(this.root, assetId)).catch((e) => { if (e.code !== "ENOENT") throw e; });
      await fs.unlink(metaFile);
      removed++;
    }
    return removed;
  }
}

function createRuntimeAssetStore(engineMode) {
  const agentRoot = process.env.RUNTIME_ASSET_DIR || path.join(os.tmpdir(), "grad-agent-assets");
  const root = engineMode === "shadow"
    ? (process.env.RUNTIME_SHADOW_ASSET_DIR || path.join(os.tmpdir(), "grad-agent-assets-shadow"))
    : agentRoot;
  if (engineMode === "shadow" && path.resolve(root).toLowerCase() === path.resolve(agentRoot).toLowerCase()) {
    throw new Error("shadow_asset_root_conflict");
  }
  return new AssetStore({ root });
}

module.exports = { AssetStore, createRuntimeAssetStore };
