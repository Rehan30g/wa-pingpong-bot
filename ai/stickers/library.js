// Koleksi stiker Grad (Plan v2 §4a): baca/tulis koleksi, log keputusan, scope
// global/lokal, dan rem pemakaian. Dipakai kurasi, tools agent loop, stiker
// pengganti reaction, dan command /stiker.
const fs = require("node:fs");
const path = require("node:path");
const { getStickerCollector } = require("./collector");

const MOODS = ["laugh", "ack", "sad", "tease", "love", "confused", "hype", "shock", "tired", "angry", "thanks", "greet"];
const FREQUENCIES = ["sering", "kadang", "jarang"];
// Jeda minimum antar pemakaian stiker yang sama, sesuai rencana frekuensi Grad.
const FREQUENCY_GAP_MS = { sering: 20 * 60_000, kadang: 3 * 3_600_000, jarang: 24 * 3_600_000 };
const FREQUENCY_WEIGHT = { sering: 0, kadang: 1, jarang: 2 };

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stickerConfig() {
  return {
    capacity: Math.max(1, envNumber("STICKER_CAPACITY", 150)),
    maxPerHour: Math.max(0, envNumber("STICKER_MAX_PER_HOUR", 4)),
    reactionChance: Math.min(1, Math.max(0, envNumber("STICKER_REACTION_CHANCE", 0.5))),
  };
}

const shortId = (sha) => String(sha || "").slice(0, 8);

function parseMoods(value) {
  try {
    const moods = JSON.parse(value || "[]");
    return Array.isArray(moods) ? moods.filter((mood) => MOODS.includes(mood)) : [];
  } catch {
    return [];
  }
}

function rowToSticker(row) {
  return {
    sha: row.sha,
    id: shortId(row.sha),
    file: row.file,
    label: row.label,
    moods: parseMoods(row.moods),
    whenToUse: row.when_to_use,
    plannedFrequency: FREQUENCIES.includes(row.planned_frequency) ? row.planned_frequency : "kadang",
    scope: row.scope === "global" ? "global" : "local",
    reason: row.reason,
    addedAt: Number(row.added_at),
    updatedAt: Number(row.updated_at),
    botUseCount: Number(row.bot_use_count || 0),
    lastBotUseAt: row.last_bot_use_at == null ? null : Number(row.last_bot_use_at),
  };
}

function createStickerLibrary(store = getStickerCollector()) {
  const now = () => (store.now ? store.now() : Date.now());
  const exec = async (sql, args = []) => (await store.db()).execute({ sql, args });

  async function listCollection() {
    return (await exec("SELECT * FROM sticker_collection ORDER BY added_at ASC")).rows.map(rowToSticker);
  }

  // Cari berdasarkan id pendek (awalan sha) di koleksi, lalu di kandidat.
  async function findSticker(prefix) {
    const value = String(prefix || "").trim().toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(value)) return null;
    const kept = (await exec("SELECT * FROM sticker_collection WHERE sha LIKE ? LIMIT 2", [`${value}%`])).rows;
    if (kept.length === 1) return { ...rowToSticker(kept[0]), status: "kept" };
    if (kept.length > 1) return { ambiguous: true };
    const candidates = (await exec("SELECT * FROM sticker_candidates WHERE sha LIKE ? LIMIT 2", [`${value}%`])).rows;
    if (candidates.length !== 1) return candidates.length ? { ambiguous: true } : null;
    const row = candidates[0];
    return { sha: row.sha, id: shortId(row.sha), file: row.file, status: row.status, useCount: Number(row.use_count), animated: Boolean(row.animated) };
  }

  async function lastDecision(sha) {
    return (await exec("SELECT kind, label, reason, source, at FROM sticker_decisions WHERE sha = ? ORDER BY at DESC, id DESC LIMIT 1", [sha])).rows[0] || null;
  }

  // Stiker lokal hanya boleh di chat tempat manusia memakainya.
  async function humanChats() {
    const rows = (await exec("SELECT sha, chat_id FROM sticker_usage WHERE by_bot = 0 GROUP BY sha, chat_id")).rows;
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.sha)) map.set(row.sha, new Set());
      map.get(row.sha).add(row.chat_id);
    }
    return map;
  }

  /**
   * Stiker koleksi yang boleh dan belum "direm" untuk chat ini.
   * Rem: jeda per stiker (planned_frequency), kuota per jam per chat, dan
   * stiker yang sama tidak dipakai dua kali berturut-turut di chat yang sama.
   */
  async function usableForChat(chatId, { at = now() } = {}) {
    const cfg = stickerConfig();
    const collection = await listCollection();
    if (!collection.length) return [];
    const chats = await humanChats();
    const botUses = (await exec("SELECT sha, at FROM sticker_usage WHERE by_bot = 1 AND chat_id = ? ORDER BY at DESC, id DESC LIMIT 50", [chatId])).rows;
    const lastInChat = botUses[0]?.sha || null;
    const usedLastHour = botUses.filter((row) => at - Number(row.at) < 3_600_000).length;
    if (usedLastHour >= cfg.maxPerHour) return [];
    return collection.filter((sticker) => {
      if (sticker.scope === "local" && !chats.get(sticker.sha)?.has(chatId)) return false;
      if (sticker.sha === lastInChat) return false;
      if (sticker.lastBotUseAt && at - sticker.lastBotUseAt < FREQUENCY_GAP_MS[sticker.plannedFrequency]) return false;
      return true;
    });
  }

  // Pemilihan deterministik tanpa panggilan GLM (pengganti reaction).
  async function pickForMood(mood, chatId, { at = now() } = {}) {
    const usable = (await usableForChat(chatId, { at })).filter((sticker) => sticker.moods.includes(mood));
    usable.sort((a, b) => FREQUENCY_WEIGHT[a.plannedFrequency] - FREQUENCY_WEIGHT[b.plannedFrequency]
      || (a.lastBotUseAt || 0) - (b.lastBotUseAt || 0)
      || a.sha.localeCompare(b.sha));
    return usable[0] || null;
  }

  // Indeks ringkas untuk konteks GLM di agent loop.
  function indexText(stickers, { limit = 60 } = {}) {
    return [...stickers]
      .sort((a, b) => FREQUENCY_WEIGHT[a.plannedFrequency] - FREQUENCY_WEIGHT[b.plannedFrequency] || b.botUseCount - a.botUseCount)
      .slice(0, limit)
      .map((s) => `${s.id} — ${s.label} [${s.moods.join(", ")}] · ${s.whenToUse.slice(0, 80)} · ${s.plannedFrequency}`)
      .join("\n");
  }

  function readFile(sticker) {
    return fs.readFileSync(path.join(store.dir, sticker.file));
  }

  async function recordBotUse(sha, chatId, { isDm = false, at = now() } = {}) {
    await exec("INSERT INTO sticker_usage (sha, chat_id, is_dm, sender, by_bot, at) VALUES (?, ?, ?, 'BOT', 1, ?)", [sha, chatId, isDm ? 1 : 0, at]);
    await exec("UPDATE sticker_collection SET bot_use_count = bot_use_count + 1, last_bot_use_at = ? WHERE sha = ?", [at, sha]);
  }

  async function logDecision(sha, kind, { label = "", reason = "", source = "curation", at = now() } = {}) {
    await exec("INSERT INTO sticker_decisions (sha, kind, label, reason, source, at) VALUES (?, ?, ?, ?, ?, ?)", [sha, kind, String(label).slice(0, 120), String(reason).slice(0, 300), source, at]);
  }

  async function markCandidate(sha, status, at) {
    await exec("UPDATE sticker_candidates SET status = ?, last_decision_use_count = use_count, last_decision_at = ? WHERE sha = ?", [status, at, sha]);
  }

  /**
   * Pastikan stiker ada sebagai kandidat berfile, dan tercatat dipakai manusia di
   * chat ini (syarat scope lokal). Dipakai save_sticker untuk stiker yang di-reply
   * walau belum pernah terkumpul, mis. dikirim sebelum bot hidup.
   */
  async function importCandidate(sha, { chatId, isDm = false, senderId = null, download = null, at = now() } = {}) {
    const row = (await exec("SELECT file FROM sticker_candidates WHERE sha = ?", [sha])).rows[0];
    let file = row?.file && fs.existsSync(path.join(store.dir, row.file)) ? row.file : null;
    if (!file) {
      const buffer = download ? await download() : null;
      if (!buffer?.length || buffer.length > 2 * 1_048_576) throw new Error("sticker_file_unavailable");
      file = `candidates/${sha}.webp`;
      fs.mkdirSync(path.join(store.dir, "candidates"), { recursive: true });
      fs.writeFileSync(path.join(store.dir, file), buffer);
    }
    await exec(`INSERT INTO sticker_candidates (sha, file, use_count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(sha) DO UPDATE SET file = excluded.file`, [sha, file, at, at]);
    const seenHere = (await exec("SELECT 1 FROM sticker_usage WHERE sha = ? AND chat_id = ? AND by_bot = 0 LIMIT 1", [sha, chatId])).rows.length;
    if (!seenHere) await exec("INSERT INTO sticker_usage (sha, chat_id, is_dm, sender, by_bot, at) VALUES (?, ?, ?, ?, 0, ?)", [sha, chatId, isDm ? 1 : 0, senderId, at]);
  }

  async function keep(sha, fields, { source = "curation", at = now() } = {}) {
    const candidate = (await exec("SELECT file FROM sticker_candidates WHERE sha = ?", [sha])).rows[0];
    if (!candidate?.file || !fs.existsSync(path.join(store.dir, candidate.file))) throw new Error("sticker_file_missing");
    const relative = `collection/${sha}.webp`;
    fs.mkdirSync(path.join(store.dir, "collection"), { recursive: true });
    fs.copyFileSync(path.join(store.dir, candidate.file), path.join(store.dir, relative));
    const moods = (fields.moods || []).filter((mood) => MOODS.includes(mood));
    await exec(`INSERT INTO sticker_collection (sha, file, label, moods, when_to_use, planned_frequency, scope, reason, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha) DO UPDATE SET label = excluded.label, moods = excluded.moods, when_to_use = excluded.when_to_use,
        planned_frequency = excluded.planned_frequency, scope = excluded.scope, reason = excluded.reason, updated_at = excluded.updated_at`, [
      sha, relative, String(fields.label || "").slice(0, 80), JSON.stringify(moods), String(fields.when_to_use || "").slice(0, 200),
      FREQUENCIES.includes(fields.planned_frequency) ? fields.planned_frequency : "kadang",
      fields.scope === "global" ? "global" : "local", String(fields.reason || "").slice(0, 300), at, at,
    ]);
    await markCandidate(sha, "kept", at);
    await logDecision(sha, "keep", { label: fields.label, reason: fields.reason, source, at });
  }

  async function skip(sha, { label = "", reason = "", source = "curation", at = now() } = {}) {
    await markCandidate(sha, "skipped", at);
    await logDecision(sha, "skip", { label, reason, source, at });
  }

  async function remove(sha, { reason = "", source = "review", at = now() } = {}) {
    const row = (await exec("SELECT label, file FROM sticker_collection WHERE sha = ?", [sha])).rows[0];
    if (!row) return false;
    await exec("DELETE FROM sticker_collection WHERE sha = ?", [sha]);
    try { fs.unlinkSync(path.join(store.dir, row.file)); } catch {}
    // Status "removed" diperlakukan seperti skip: bisa dinilai ulang kalau pemakaian manusia naik.
    await markCandidate(sha, "removed", at);
    await logDecision(sha, "remove", { label: row.label, reason, source, at });
    return true;
  }

  async function revise(sha, fields, { source = "review", at = now() } = {}) {
    const current = (await exec("SELECT * FROM sticker_collection WHERE sha = ?", [sha])).rows[0];
    if (!current) return false;
    const next = rowToSticker(current);
    const label = fields.label?.trim() ? fields.label.trim().slice(0, 80) : next.label;
    const moods = Array.isArray(fields.moods) && fields.moods.length ? fields.moods.filter((m) => MOODS.includes(m)) : next.moods;
    const when = fields.when_to_use?.trim() ? fields.when_to_use.trim().slice(0, 200) : next.whenToUse;
    const frequency = FREQUENCIES.includes(fields.planned_frequency) ? fields.planned_frequency : next.plannedFrequency;
    await exec("UPDATE sticker_collection SET label = ?, moods = ?, when_to_use = ?, planned_frequency = ?, updated_at = ? WHERE sha = ?", [label, JSON.stringify(moods), when, frequency, at, sha]);
    await logDecision(sha, "revise", { label, reason: fields.reason, source, at });
    return true;
  }

  async function recentDecisions(limit = 5) {
    return (await exec("SELECT sha, kind, label, reason, source, at FROM sticker_decisions ORDER BY at DESC, id DESC LIMIT ?", [limit])).rows
      .map((row) => ({ ...row, id: shortId(row.sha), at: Number(row.at) }));
  }

  async function favorites(limit = 10) {
    return (await exec("SELECT * FROM sticker_collection ORDER BY bot_use_count DESC, added_at ASC LIMIT ?", [limit])).rows.map(rowToSticker);
  }

  async function getMeta(key) {
    return (await exec("SELECT value FROM sticker_meta WHERE key = ?", [key])).rows[0]?.value ?? null;
  }

  async function setMeta(key, value) {
    await exec("INSERT INTO sticker_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }

  // Label stiker koleksi untuk memperkaya teks "[mengirim stiker]" di riwayat.
  async function labelFor(sha) {
    return (await exec("SELECT label FROM sticker_collection WHERE sha = ?", [sha])).rows[0]?.label || null;
  }

  return {
    store, exec, now,
    listCollection, findSticker, lastDecision, usableForChat, pickForMood, indexText, readFile,
    recordBotUse, logDecision, importCandidate, keep, skip, remove, revise, recentDecisions, favorites, getMeta, setMeta, labelFor,
  };
}

let shared = null;
function getStickerLibrary() {
  const store = getStickerCollector();
  if (!shared || shared.store !== store) shared = createStickerLibrary(store);
  return shared;
}

const REACTION_MOODS = { react_laugh: "laugh", react_ack: "ack", react_heart: "love", react_surprised: "shock" };

module.exports = { FREQUENCIES, MOODS, REACTION_MOODS, createStickerLibrary, getStickerLibrary, shortId, stickerConfig };
