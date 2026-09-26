// Proaktif di grup (Plan v2 M5). Dua jalur lewat sinyal Jev `opportunity`:
//  - help: ada bantuan nyata walau bot tidak dipanggil (cooldown pendek);
//  - social: ikut nimbrung seperti member (cooldown panjang, kuota per jam,
//    mati di jam tenang, dan fitur "sosial" per grup).
// Rem otomatis: "grad diem dulu" / "jangan nimbrung" mematikan keduanya X jam.
const humanize = require("../humanize");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function proactiveConfig() {
  return {
    helpCooldownMs: Math.max(0, envNumber("AGENT_HELP_COOLDOWN_MIN", 2)) * 60_000,
    socialCooldownMs: Math.max(0, envNumber("AGENT_SOCIAL_COOLDOWN_MIN", 20)) * 60_000,
    socialMaxPerHour: Math.max(0, envNumber("AGENT_SOCIAL_MAX_PER_HOUR", 2)),
    muteMs: Math.max(0, envNumber("AGENT_SOCIAL_MUTE_HOURS", 3)) * 3_600_000,
    confidence: Math.min(1, Math.max(0, envNumber("AGENT_PROACTIVE_CONFIDENCE", 0.6))),
  };
}

const state = new Map(); // groupId -> { lastHelp, social: [at...], mutedUntil }

function groupState(groupId) {
  if (!state.has(groupId)) state.set(groupId, { lastHelp: 0, social: [], mutedUntil: 0 });
  return state.get(groupId);
}

function isMuted(groupId, at = Date.now()) {
  return groupState(groupId).mutedUntil > at;
}

/** @returns {{ ok: boolean, reason?: string }} */
function checkHelp(groupId, at = Date.now()) {
  const cfg = proactiveConfig();
  const s = groupState(groupId);
  if (isMuted(groupId, at)) return { ok: false, reason: "muted" };
  if (at - s.lastHelp < cfg.helpCooldownMs) return { ok: false, reason: "cooldown" };
  return { ok: true };
}

function checkSocial(groupId, at = Date.now()) {
  const cfg = proactiveConfig();
  const s = groupState(groupId);
  if (isMuted(groupId, at)) return { ok: false, reason: "muted" };
  if (humanize.isQuietHours(at)) return { ok: false, reason: "quiet_hours" };
  s.social = s.social.filter((time) => at - time < 3_600_000);
  if (s.social.length >= cfg.socialMaxPerHour) return { ok: false, reason: "hourly_limit" };
  if (s.social.length && at - Math.max(...s.social) < cfg.socialCooldownMs) return { ok: false, reason: "cooldown" };
  return { ok: true };
}

function markHelp(groupId, at = Date.now()) {
  groupState(groupId).lastHelp = at;
}

function markSocial(groupId, at = Date.now()) {
  groupState(groupId).social.push(at);
}

function mute(groupId, at = Date.now()) {
  groupState(groupId).mutedUntil = at + proactiveConfig().muteMs;
  return groupState(groupId).mutedUntil;
}

function unmute(groupId) {
  groupState(groupId).mutedUntil = 0;
}

const MUTE_PATTERN = /\b(diam|diem|dim|mingkem|berisik|jangan\s+(?:nimbrung|ikut(?:\s+campur)?|nyamber|ganggu|nyela)|stop\s+nimbrung|gak\s+usah\s+(?:nimbrung|ikut)|ga\s+usah\s+(?:nimbrung|ikut)|nggak\s+usah\s+(?:nimbrung|ikut))\b/i;

// "grad diem dulu", "@Grad jangan nimbrung" — harus ditujukan ke bot.
function isMuteRequest(text, { addressed = false } = {}) {
  return addressed && MUTE_PATTERN.test(String(text || "")) && String(text || "").length <= 120;
}

function status(groupId, at = Date.now()) {
  const s = groupState(groupId);
  return {
    mutedUntil: s.mutedUntil > at ? s.mutedUntil : null,
    socialLastHour: s.social.filter((time) => at - time < 3_600_000).length,
    help: checkHelp(groupId, at),
    social: checkSocial(groupId, at),
  };
}

function reset() {
  state.clear();
}

module.exports = { checkHelp, checkSocial, isMuteRequest, isMuted, markHelp, markSocial, mute, proactiveConfig, reset, status, unmute };
