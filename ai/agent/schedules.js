// Reminder & jadwal di chat asal (Plan v2 M3). GLM mengisi waktu WIT eksplisit
// ("YYYY-MM-DD HH:MM"); kode yang menghitung epoch dan perulangan. Tujuan kirim
// selalu chat asal jadwal dibuat, tidak pernah dari argumen model.
const scheduler = require("../scheduler");
const humanize = require("../humanize");

const DAY = 86_400_000;
const MAX_PER_CHAT = 30;
const DAY_NAMES = ["", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

function witEpoch({ year, month, day, hour, minute }) {
  return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
}

// "2026-09-27 08:00" → epoch (WIT). null bila format/nilai tidak valid.
function parseWit(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const at = witEpoch({ year, month, day, hour, minute });
  const back = humanize.witParts(at);
  return back.day === day && back.month === month ? at : null;
}

// Senin=1 … Minggu=7 dalam WIT.
function witWeekday(at) {
  const day = new Date(at + 9 * 3_600_000).getUTCDay();
  return day === 0 ? 7 : day;
}

function formatWit(at) {
  const p = humanize.witParts(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${DAY_NAMES[witWeekday(at)]}, ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} WIT`;
}

/** Kejadian berikutnya setelah `after` untuk perulangan harian/mingguan. */
function nextOccurrence(recurrence, after) {
  if (!recurrence || recurrence.type === "none") return null;
  const [hour, minute] = String(recurrence.time).split(":").map(Number);
  const days = recurrence.type === "weekly" ? (recurrence.days || []).filter((d) => d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7];
  if (!days.length || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const base = humanize.witParts(after);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = witEpoch({ year: base.year, month: base.month, day: base.day + offset, hour, minute });
    if (candidate > after && days.includes(witWeekday(candidate))) return candidate;
  }
  return null;
}

function describe(job) {
  const r = job.payload?.recurrence;
  const repeat = !r || r.type === "none" ? "" : r.type === "daily" ? ` · tiap hari ${r.time}` : ` · tiap ${r.days.map((d) => DAY_NAMES[d]).join(", ")} ${r.time}`;
  return {
    id: job.id,
    kind: job.type === "chat_task" ? "task" : "reminder",
    text: job.payload?.text || "",
    next: formatWit(job.fire_at),
    repeat: repeat.replace(/^ · /, "") || "sekali",
  };
}

function chatJobs(chatId) {
  return scheduler.listJobs().filter((job) => ["chat_reminder", "chat_task"].includes(job.type) && job.payload?.chatId === chatId);
}

/**
 * Kontrol jadwal yang terikat pada satu chat (dipakai tools agent loop).
 * @param {object} opts { chatId, isDm, createdBy }
 */
function forChat({ chatId, isDm = false, createdBy = null, now = () => Date.now() }) {
  return {
    create({ kind = "reminder", text, at, repeat = "none", days = [] }) {
      const body = String(text || "").trim().slice(0, 500);
      if (!body) return { error: "isi pengingat/tugas kosong" };
      const first = parseWit(at);
      if (!first) return { error: "format waktu harus 'YYYY-MM-DD HH:MM' (WIT)" };
      const current = now();
      if (first > current + 400 * DAY) return { error: "waktu terlalu jauh (maks 400 hari)" };
      let recurrence = null;
      if (repeat === "daily" || repeat === "weekly") {
        const p = humanize.witParts(first);
        const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
        recurrence = { type: repeat, time, days: repeat === "weekly" ? [...new Set((days.length ? days : [witWeekday(first)]).map(Number))].filter((d) => d >= 1 && d <= 7) : [] };
      }
      // Waktu yang sudah lewat: jadwal berulang maju ke kejadian berikutnya, sekali jalan ditolak.
      const fireAt = first > current ? first : recurrence ? nextOccurrence(recurrence, current) : null;
      if (!fireAt) return { error: `waktu ${formatWit(first)} sudah lewat` };
      if (chatJobs(chatId).length >= MAX_PER_CHAT) return { error: `jadwal di chat ini sudah ${MAX_PER_CHAT}, batalkan yang lama dulu` };
      const job = scheduler.scheduleJob({
        type: kind === "task" ? "chat_task" : "chat_reminder",
        fire_at: fireAt,
        payload: { chatId, isDm, text: body, recurrence, createdBy },
      });
      if (!job) return { error: "jadwal gagal disimpan" };
      return { ok: true, ...describe(job) };
    },
    list() {
      return { schedules: chatJobs(chatId).map(describe) };
    },
    cancel({ id }) {
      const job = chatJobs(chatId).find((item) => item.id === String(id || "").trim());
      if (!job) return { error: "jadwal dengan id itu tidak ada di chat ini" };
      scheduler.cancelJob(job.id);
      return { ok: true, cancelled: describe(job) };
    },
  };
}

module.exports = { formatWit, forChat, nextOccurrence, parseWit, witWeekday };
