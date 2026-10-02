// Pengumpulan stiker Grad (Plan v2 §4a): setiap stiker yang dipakai manusia di
// grup yang diizinkan atau DM yang di-whitelist dicatat sebagai kandidat (hash,
// file, statistik, cuplikan konteks). Modul ini juga pemilik DB stiker; kurasi
// ada di curator.js dan pemakaian koleksi di library.js.
const fs = require("node:fs");
const path = require("node:path");
const { createDb } = require("../runtime/storage/db");
const { redactString } = require("../observability/redact");

const MAX_CONTEXTS_PER_STICKER = 5;
const CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 160;
const MAX_STICKER_BYTES = 2 * 1_048_576;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sticker_candidates (
    sha TEXT PRIMARY KEY,
    file TEXT,
    mimetype TEXT,
    animated INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
  )`,
  `CREATE TABLE IF NOT EXISTS sticker_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    is_dm INTEGER NOT NULL DEFAULT 0,
    sender TEXT,
    by_bot INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sticker_usage_sha ON sticker_usage(sha)",
  `CREATE TABLE IF NOT EXISTS sticker_contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    is_dm INTEGER NOT NULL DEFAULT 0,
    before TEXT NOT NULL DEFAULT '',
    after TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sticker_contexts_sha ON sticker_contexts(sha)",
  // M2: koleksi hasil kurasi, log keputusan, dan status penjadwal kurasi.
  `CREATE TABLE IF NOT EXISTS sticker_collection (
    sha TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    label TEXT NOT NULL,
    moods TEXT NOT NULL DEFAULT '[]',
    when_to_use TEXT NOT NULL DEFAULT '',
    planned_frequency TEXT NOT NULL DEFAULT 'kadang',
    scope TEXT NOT NULL DEFAULT 'local',
    reason TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    bot_use_count INTEGER NOT NULL DEFAULT 0,
    last_bot_use_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sticker_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'curation',
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sticker_decisions_at ON sticker_decisions(at)",
  "CREATE TABLE IF NOT EXISTS sticker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  // Deskripsi gerakan stiker animasi dari "mata gerak" (ai/media/motion.js), sekali per stiker.
  `CREATE TABLE IF NOT EXISTS sticker_motion (
    sha TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    motion TEXT NOT NULL DEFAULT '',
    emotion TEXT NOT NULL DEFAULT '',
    text_in_media TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  )`,
];

// Kolom yang ditambahkan setelah M0 (DB lama dimigrasi di tempat).
const CANDIDATE_COLUMNS = {
  last_decision_use_count: "INTEGER NOT NULL DEFAULT 0",
  last_decision_at: "INTEGER",
};

async function migrate(conn) {
  for (const sql of SCHEMA) await conn.execute(sql);
  const existing = new Set((await conn.execute("PRAGMA table_info(sticker_candidates)")).rows.map((row) => row.name));
  for (const [column, type] of Object.entries(CANDIDATE_COLUMNS)) {
    if (!existing.has(column)) await conn.execute(`ALTER TABLE sticker_candidates ADD COLUMN ${column} ${type}`);
  }
}

function stickerDir() {
  return path.resolve(process.env.STICKER_DIR || "./data/stickers");
}

// fileSha256 dari Baileys bisa Buffer/Uint8Array, atau string base64 bila pesan
// pernah diserialisasi ke JSON.
function stickerSha(fileSha256) {
  if (!fileSha256) return null;
  let buffer = null;
  if (typeof fileSha256 === "string") buffer = Buffer.from(fileSha256, "base64");
  else if (fileSha256 instanceof Uint8Array) buffer = Buffer.from(fileSha256);
  else if (Array.isArray(fileSha256?.data)) buffer = Buffer.from(fileSha256.data);
  if (!buffer || buffer.length < 16) return null;
  return buffer.toString("hex");
}

function redactContextLine(text) {
  return redactString(String(text || ""))
    .replace(/\+?\d[\d\s-]{8,}\d/g, "[nomor]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE_CHARS);
}

function createStickerCollector({ dbPath, dir = stickerDir(), now = () => Date.now() } = {}) {
  const baseDir = path.resolve(dir);
  const candidateDir = path.join(baseDir, "candidates");
  const resolvedDbPath = dbPath || process.env.STICKER_DB_PATH || path.join(baseDir, "stickers.db");
  let dbPromise = null;
  const recentLines = new Map(); // chatId -> baris terakhir (untuk konteks "sebelum")
  const pendingAfter = new Map(); // chatId -> [{ contextId, lines: [] }]
  const downloading = new Set();

  function db() {
    if (!dbPromise) {
      dbPromise = (async () => {
        fs.mkdirSync(candidateDir, { recursive: true });
        fs.mkdirSync(path.join(baseDir, "collection"), { recursive: true });
        const conn = await createDb(resolvedDbPath);
        await migrate(conn);
        return conn;
      })();
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  function rememberLine(chatId, line) {
    const lines = recentLines.get(chatId) || [];
    lines.push(line);
    while (lines.length > CONTEXT_LINES) lines.shift();
    recentLines.set(chatId, lines);
  }

  async function feedPendingAfter(conn, chatId, line) {
    const pending = pendingAfter.get(chatId);
    if (!pending?.length) return;
    for (const item of pending) {
      item.lines.push(line);
      await conn.execute({ sql: "UPDATE sticker_contexts SET after = ? WHERE id = ?", args: [item.lines.join("\n"), item.contextId] });
    }
    const open = pending.filter((item) => item.lines.length < CONTEXT_LINES);
    if (open.length) pendingAfter.set(chatId, open);
    else pendingAfter.delete(chatId);
  }

  async function saveFile(conn, sha, download) {
    if (!download || downloading.has(sha)) return;
    downloading.add(sha);
    try {
      const buffer = await download();
      if (!buffer?.length || buffer.length > MAX_STICKER_BYTES) return;
      const file = path.join(candidateDir, `${sha}.webp`);
      fs.writeFileSync(file, buffer);
      await conn.execute({ sql: "UPDATE sticker_candidates SET file = ? WHERE sha = ?", args: [path.relative(baseDir, file).replace(/\\/g, "/"), sha] });
    } catch (error) {
      // File akan dicoba lagi saat stiker yang sama terlihat berikutnya.
      console.warn("[STIKER] Gagal mengunduh stiker:", error.message);
    } finally {
      downloading.delete(sha);
    }
  }

  /**
   * Catat satu pesan dari chat yang boleh dipantau. Pesan teks hanya mengisi
   * cuplikan konteks; pesan stiker menambah statistik dan kandidat.
   */
  async function observeNow({ chatId, isDm = false, senderId = null, senderName = "", text = "", sticker = null, download = null, at = now() } = {}) {
    if (!chatId) return null;
    const who = String(senderName || "seseorang").slice(0, 40);
    const sha = sticker ? stickerSha(sticker.fileSha256) : null;
    const line = sha ? `${who}: [stiker]` : `${who}: ${redactContextLine(text)}`;
    if (!sha && !String(text || "").trim()) return null;

    const conn = await db();
    await feedPendingAfter(conn, chatId, line);
    if (!sha) {
      rememberLine(chatId, line);
      return null;
    }

    await conn.execute({
      sql: `INSERT INTO sticker_candidates (sha, mimetype, animated, width, height, use_count, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(sha) DO UPDATE SET use_count = use_count + 1, last_seen = excluded.last_seen`,
      args: [sha, sticker.mimetype || "image/webp", sticker.isAnimated ? 1 : 0, Number(sticker.width) || null, Number(sticker.height) || null, at, at],
    });
    await conn.execute({
      sql: "INSERT INTO sticker_usage (sha, chat_id, is_dm, sender, by_bot, at) VALUES (?, ?, ?, ?, 0, ?)",
      args: [sha, chatId, isDm ? 1 : 0, senderId || null, at],
    });

    const count = await conn.execute({ sql: "SELECT COUNT(*) AS n FROM sticker_contexts WHERE sha = ?", args: [sha] });
    if (Number(count.rows[0].n) >= MAX_CONTEXTS_PER_STICKER) {
      await conn.execute({
        sql: "DELETE FROM sticker_contexts WHERE id = (SELECT id FROM sticker_contexts WHERE sha = ? ORDER BY at ASC, id ASC LIMIT 1)",
        args: [sha],
      });
    }
    const before = (recentLines.get(chatId) || []).join("\n");
    const inserted = await conn.execute({
      sql: "INSERT INTO sticker_contexts (sha, chat_id, is_dm, before, at) VALUES (?, ?, ?, ?, ?)",
      args: [sha, chatId, isDm ? 1 : 0, before, at],
    });
    const pending = pendingAfter.get(chatId) || [];
    pending.push({ contextId: Number(inserted.lastInsertRowid), lines: [] });
    pendingAfter.set(chatId, pending);
    rememberLine(chatId, line);

    const row = await conn.execute({ sql: "SELECT file FROM sticker_candidates WHERE sha = ?", args: [sha] });
    const file = row.rows[0]?.file;
    if (!file || !fs.existsSync(path.join(baseDir, file))) await saveFile(conn, sha, download);
    return sha;
  }

  // Pesan diproses berurutan supaya cuplikan konteks sebelum/sesudah tidak tertukar.
  let queue = Promise.resolve();
  function observe(input) {
    const run = queue.catch(() => {}).then(() => observeNow(input));
    queue = run;
    return run;
  }

  async function stats({ at = now(), limit = 5 } = {}) {
    const conn = await db();
    const one = async (sql, args = []) => (await conn.execute({ sql, args })).rows[0];
    const totals = await one(`SELECT COUNT(*) AS candidates,
      SUM(CASE WHEN file IS NOT NULL THEN 1 ELSE 0 END) AS stored
      FROM sticker_candidates WHERE status = 'candidate'`);
    // Pemakaian manusia dihitung dari semua stiker, termasuk yang sudah masuk koleksi.
    const allUses = await one("SELECT COALESCE(SUM(use_count), 0) AS uses FROM sticker_candidates");
    const today = await one("SELECT COUNT(*) AS n, COUNT(DISTINCT sha) AS stickers FROM sticker_usage WHERE by_bot = 0 AND at >= ?", [at - 86_400_000]);
    const perSticker = `SELECT c.sha, c.use_count, c.last_seen, c.animated,
        COUNT(DISTINCT u.chat_id) AS chats, COUNT(DISTINCT u.sender) AS senders
      FROM sticker_candidates c LEFT JOIN sticker_usage u ON u.sha = c.sha AND u.by_bot = 0
      WHERE c.status = 'candidate'
      GROUP BY c.sha`;
    const top = (await conn.execute({ sql: `${perSticker} ORDER BY c.use_count DESC, c.last_seen DESC LIMIT ?`, args: [limit] })).rows;
    const newest = (await conn.execute({ sql: "SELECT sha, first_seen FROM sticker_candidates ORDER BY first_seen DESC LIMIT ?", args: [limit] })).rows;
    const collection = await one("SELECT COUNT(*) AS n FROM sticker_collection");
    const skipped = await one("SELECT COUNT(*) AS n FROM sticker_candidates WHERE status = 'skipped'");
    return {
      candidates: Number(totals.candidates || 0),
      stored: Number(totals.stored || 0),
      uses: Number(allUses.uses || 0),
      usesLast24h: Number(today.n || 0),
      stickersLast24h: Number(today.stickers || 0),
      collection: Number(collection.n || 0),
      skipped: Number(skipped.n || 0),
      top: top.map((row) => ({
        sha: row.sha,
        useCount: Number(row.use_count),
        chats: Number(row.chats),
        senders: Number(row.senders),
        lastSeen: Number(row.last_seen),
        animated: Boolean(row.animated),
      })),
      newest: newest.map((row) => ({ sha: row.sha, firstSeen: Number(row.first_seen) })),
    };
  }

  async function contexts(sha) {
    const conn = await db();
    const rows = (await conn.execute({ sql: "SELECT chat_id, is_dm, before, after, at FROM sticker_contexts WHERE sha = ? ORDER BY at ASC, id ASC", args: [sha] })).rows;
    return rows.map((row) => ({ chatId: row.chat_id, isDm: Boolean(row.is_dm), before: row.before, after: row.after, at: Number(row.at) }));
  }

  async function close() {
    if (!dbPromise) return;
    const conn = await dbPromise.catch(() => null);
    dbPromise = null;
    conn?.client?.close?.();
  }

  const flush = () => queue.catch(() => {});

  async function getMotion(sha) {
    const row = (await (await db()).execute({ sql: "SELECT * FROM sticker_motion WHERE sha = ?", args: [sha] })).rows[0];
    return row ? { summary: row.summary, motion: row.motion, emotion: row.emotion, text: row.text_in_media, model: row.model } : null;
  }

  async function saveMotion(sha, result, at = now()) {
    await (await db()).execute({
      sql: `INSERT INTO sticker_motion (sha, summary, motion, emotion, text_in_media, model, at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sha) DO UPDATE SET summary = excluded.summary, motion = excluded.motion, emotion = excluded.emotion,
              text_in_media = excluded.text_in_media, model = excluded.model, at = excluded.at`,
      args: [sha, result.summary, result.motion || "", result.emotion || "", result.text || "", result.model || "", at],
    });
  }

  return { observe, flush, stats, contexts, close, db, now, getMotion, saveMotion, dir: baseDir, dbPath: resolvedDbPath };
}

let shared = null;
function getStickerCollector() {
  if (!shared) shared = createStickerCollector();
  return shared;
}

async function resetStickerCollector() {
  if (shared) await shared.close();
  shared = null;
}

module.exports = {
  createStickerCollector,
  getStickerCollector,
  resetStickerCollector,
  stickerSha,
  redactContextLine,
};
