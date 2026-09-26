// Fitur per grup (Plan v2 M2b). Dua level:
//  - owner mengunci/membuka fitur secara global (kunci = mati di semua chat);
//  - admin WA grup + owner menyalakan/mematikan fitur per grup, dalam batas itu.
// Ditegakkan di kode: tools fitur yang mati tidak pernah dikirim ke GLM.
const fs = require("node:fs");
const path = require("node:path");
const activity = require("./observability/activity");

// available=false: fitur milestone berikutnya, belum ditampilkan/diatur.
const FEATURES = {
  web: { label: "Cari & baca web", default: true, available: true },
  audio: { label: "Dengar voice note", default: true, available: true },
  stiker: { label: "Koleksi & kirim stiker", default: true, available: true },
  media: { label: "Lihat gambar/video", default: true, available: true },
  reminder: { label: "Reminder & jadwal", default: true, available: true },
  memori: { label: "Ingat fakta & catatan", default: true, available: true },
  latar: { label: "Tugas latar panjang (subagent)", default: true, available: true },
  edit_media: { label: "Edit video/audio/GIF & stiker animasi", default: true, available: true },
  sosial: { label: "Nimbrung tanpa dipanggil", default: true, available: true },
  workspace: { label: "File workspace grup", default: false, available: false, lockedByDefault: true },
  // Python aktif default: sandbox sudah terisolasi (tanpa file bot, env, atau jaringan langsung).
  python: { label: "Python sandbox (hitung, grafik, QR, API)", default: true, available: true },
  skill: { label: "Skill bawaan (resep tugas: QR, kurs, cuaca, patungan, …)", default: true, available: true },
};
const LOG_LIMIT = 300;

function featuresFile() {
  return path.resolve(process.env.FEATURES_FILE || "./features.json");
}

let cache = null;
let cacheFile = null;

function load() {
  const file = featuresFile();
  if (cache && cacheFile === file) return cache;
  let raw = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn("[FITUR] features.json tidak terbaca, memakai default:", error.message);
  }
  cache = {
    global: { locked: raw.global?.locked && typeof raw.global.locked === "object" ? raw.global.locked : {} },
    groups: raw.groups && typeof raw.groups === "object" ? raw.groups : {},
    log: Array.isArray(raw.log) ? raw.log : [],
  };
  cacheFile = file;
  return cache;
}

function save() {
  const file = featuresFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache, null, 2));
  fs.renameSync(temp, file);
}

function isFeature(name) {
  return Object.prototype.hasOwnProperty.call(FEATURES, name);
}

function availableFeatures() {
  return Object.keys(FEATURES).filter((name) => FEATURES[name].available);
}

function isLocked(name) {
  const locked = load().global.locked[name];
  return typeof locked === "boolean" ? locked : Boolean(FEATURES[name]?.lockedByDefault);
}

// Nilai efektif di chat ini. DM tidak punya setelan sendiri: hanya default + kunci global.
function isEnabled(chatId, name) {
  if (!isFeature(name) || isLocked(name)) return false;
  const setting = String(chatId || "").endsWith("@g.us") ? load().groups[chatId]?.[name] : undefined;
  return typeof setting === "boolean" ? setting : FEATURES[name].default;
}

function enabledSet(chatId) {
  return new Set(Object.keys(FEATURES).filter((name) => isEnabled(chatId, name)));
}

function statusFor(chatId) {
  return availableFeatures().map((name) => ({
    name,
    label: FEATURES[name].label,
    enabled: isEnabled(chatId, name),
    locked: isLocked(name),
    custom: typeof load().groups[chatId]?.[name] === "boolean",
  }));
}

function appendLog(entry) {
  const data = load();
  data.log.push({ at: Date.now(), ...entry });
  activity.record("feature", entry);
  if (data.log.length > LOG_LIMIT) data.log.splice(0, data.log.length - LOG_LIMIT);
}

/**
 * Nyalakan/matikan fitur di satu grup. Fitur yang dikunci owner tidak bisa
 * dinyalakan (mematikan tetap boleh). `by` = { phone, role: owner|admin|dashboard }.
 */
function setGroupFeature(chatId, name, enabled, by = {}) {
  if (!String(chatId).endsWith("@g.us")) return { ok: false, error: "bukan_grup" };
  if (!isFeature(name) || !FEATURES[name].available) return { ok: false, error: "fitur_tidak_dikenal" };
  if (enabled && isLocked(name)) return { ok: false, error: "dikunci_owner" };
  const data = load();
  const before = isEnabled(chatId, name);
  data.groups[chatId] = { ...(data.groups[chatId] || {}), [name]: Boolean(enabled) };
  appendLog({ scope: chatId, feature: name, from: before, to: Boolean(enabled), by: by.phone || null, role: by.role || null });
  save();
  return { ok: true, before, after: isEnabled(chatId, name) };
}

function setGlobalLock(name, locked, by = {}) {
  if (!isFeature(name)) return { ok: false, error: "fitur_tidak_dikenal" };
  const data = load();
  const before = isLocked(name);
  data.global.locked[name] = Boolean(locked);
  appendLog({ scope: "global", feature: name, from: before ? "kunci" : "buka", to: locked ? "kunci" : "buka", by: by.phone || null, role: by.role || null });
  save();
  return { ok: true, before, after: isLocked(name) };
}

function recentLog(limit = 50, scope = null) {
  return load().log.filter((entry) => !scope || entry.scope === scope).slice(-limit).reverse();
}

function resetCache() {
  cache = null;
  cacheFile = null;
}

module.exports = {
  FEATURES,
  availableFeatures,
  enabledSet,
  isEnabled,
  isFeature,
  isLocked,
  recentLog,
  resetCache,
  setGlobalLock,
  setGroupFeature,
  statusFor,
};
