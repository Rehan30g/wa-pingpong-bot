const WIT_TIME_ZONE = "Asia/Jayapura";

function witParts(at = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WIT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function witEpoch({ year, month, day, hour = 0, minute = 0 }) {
  // WIT = UTC+9 tanpa DST.
  return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
}

function witEpochAt(hour, minute, now = Date.now(), nextDay = false) {
  const current = witParts(now);
  return witEpoch({
    year: current.year,
    month: current.month,
    day: current.day + (nextDay ? 1 : 0),
    hour,
    minute,
  });
}

function quietConfig() {
  const start = Number(process.env.AI_AGENT_QUIET_START ?? 22);
  const end = Number(process.env.AI_AGENT_QUIET_END ?? 7);
  return {
    start: Number.isFinite(start) ? start : 22,
    end: Number.isFinite(end) ? end : 7,
  };
}

function isQuietHours(at = Date.now(), { start, end } = quietConfig()) {
  if (start === end) return false;
  const { hour } = witParts(at);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function replyDelayMs(text, { min = 500, max = 2_200, perChar = 25, cap = 5_000 } = {}) {
  const scale = Number(process.env.AI_HUMAN_DELAY_SCALE ?? 1);
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const length = String(text || "").trim().length;
  const base = Math.min(cap, length * perChar);
  const jitter = min + Math.random() * Math.max(0, max - min);
  return Math.round((base + jitter) * scale);
}

function splitReply(text, { maxParts = 2, threshold = 140 } = {}) {
  const value = String(text || "").trim();
  if (value.length < threshold || maxParts < 2) return [value];
  const sentences = value.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length < 2) return [value];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && parts.length < maxParts - 1 && candidate.length > threshold) {
      parts.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.filter(Boolean).slice(0, maxParts);
}

const BROADCAST_PATTERNS = [
  /\b(sebar(?:kan|in)?|broadcast|broadcastin|forward(?:kan)?|spam(?:in)?)\b/i,
  /\b(?:bilang(?:in|kan)?|kabari|kasih(?:\s+tahu)?|info(?:rmasi)?(?:in)?)\s+(?:ke\s+)?(?:semua|semua orang|tiap orang|orang[- ]orang)\b/i,
  /\b(?:chat|kirim|wa|whatsapp)(?:in)?\s+(?:ke\s+)?semua\s+(?:orang|anggota|kontak|grup|grup)\b/i,
  /\b(?:ke|untuk)\s+semua\s+(?:orang|anggota|kontak)\b/i,
  /\bots?\s+semua\b/i,
];

function detectBroadcastIntent(text) {
  const value = String(text || "");
  return BROADCAST_PATTERNS.some((pattern) => pattern.test(value));
}

function detectOptOut(text) {
  const value = String(text || "");
  return (
    /\b(?:jangan|stop|udah(?:an|lah)?|gak|nggak|ga)\s+(?:usahlah|usah)?\s*(?:chat|dm|wa|whatsapp|hubungi|ganggu|kabari|pesan)\b/i.test(value) ||
    /\b(?:jangan|stop)\s+ganggu(?:in)?\b/i.test(value) ||
    /\bjangan\s+(?:chat|dm)\s+(?:aku|gue|saya)\b/i.test(value)
  );
}

function detectOptIn(text) {
  return /\b(?:boleh|boleh kok|semua ok|ok|silakan|gpp|gak apa)\b.{0,20}\b(?:chat|dm|kabari|hubungi)\b/i.test(String(text || ""));
}

function parseReminderRequest(text, now = Date.now()) {
  const value = String(text || "");
  if (!/\b(ing[ae]t(?:in|kan)|remind(?:er|kan)?)\b/i.test(value)) return null;
  const clean = value
    .replace(/^.*?\b(?:ing[ae]t(?:in|kan)|remind(?:er|kan)?)\b/i, "")
    .replace(/^[\s,:.\-]+/, "")
    .replace(/\b(?:ya|dong|nih|please|plis)\b/gi, "")
    .trim() || "ada yang mau diingatkan";
  let fireAt = null;
  let match;
  if ((match = value.match(/(\d+)\s*(menit|minute?s?|min)\b/i))) {
    fireAt = now + Number(match[1]) * 60_000;
  } else if ((match = value.match(/(\d+)\s*(jam|hour?s?|hr)\b/i))) {
    fireAt = now + Number(match[1]) * 3_600_000;
  } else if ((match = value.match(/\bjam\s*(\d{1,2})(?:[:.](\d{2}))?/i))) {
    fireAt = witEpochAt(Number(match[1]), Number(match[2] || 0), now);
    if (fireAt <= now) fireAt = witEpochAt(Number(match[1]), Number(match[2] || 0), now, true);
  } else if (/\bbesok\b/i.test(value)) {
    fireAt = witEpochAt(8, 0, now, true);
  }
  if (!fireAt || !Number.isFinite(fireAt)) return null;
  return { fireAt, text: clean.slice(0, 240) };
}

module.exports = {
  BROADCAST_PATTERNS,
  detectBroadcastIntent,
  detectOptIn,
  detectOptOut,
  isQuietHours,
  parseReminderRequest,
  quietConfig,
  replyDelayMs,
  sleep,
  splitReply,
  witEpochAt,
  witParts,
};
