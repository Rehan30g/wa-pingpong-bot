const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-schedules-");
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_DM_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const schedules = require("../ai/agent/schedules");
const scheduler = require("../ai/scheduler");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");

test.after(() => cleanup());

const GROUP = "120363777000111@g.us";
const OTHER = "120363777000222@g.us";
const PHONE = "628111222333";
const HOUR = 3_600_000;
// Sabtu, 26 Sep 2026 21:00 WIT
const NOW = Date.UTC(2026, 8, 26, 12, 0);
// Dua hari dari sekarang (waktu nyata), format "YYYY-MM-DD 08:00".
const SOON = (() => { const p = require("../ai/humanize").witParts(Date.now() + 2 * 24 * HOUR); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} 08:00`; })();

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content, options) => { sent.push({ jid, ...content, options }); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

function reset() {
  scheduler.clearJobs();
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
}

test("waktu WIT: parse, format, dan kejadian berikutnya harian/mingguan", () => {
  assert.equal(schedules.parseWit("2026-09-27 08:00"), Date.UTC(2026, 8, 26, 23, 0));
  assert.equal(schedules.parseWit("2026-02-30 08:00"), null, "tanggal tidak ada");
  assert.equal(schedules.parseWit("besok jam 8"), null);
  assert.equal(schedules.formatWit(NOW), "Sabtu, 2026-09-26 21:00 WIT");
  assert.equal(schedules.formatWit(schedules.nextOccurrence({ type: "daily", time: "07:00" }, NOW)), "Minggu, 2026-09-27 07:00 WIT");
  assert.equal(schedules.formatWit(schedules.nextOccurrence({ type: "weekly", time: "07:00", days: [1] }, NOW)), "Senin, 2026-09-28 07:00 WIT");
  assert.equal(schedules.formatWit(schedules.nextOccurrence({ type: "weekly", time: "22:00", days: [6] }, NOW)), "Sabtu, 2026-09-26 22:00 WIT", "hari yang sama bila belum lewat");
});

test("forChat: buat, tolak waktu lewat, majukan jadwal berulang, list & cancel hanya di chat sendiri", () => {
  reset();
  const group = schedules.forChat({ chatId: GROUP, now: () => NOW });
  const once = group.create({ kind: "reminder", text: "Rapat jam 8 ya!", at: "2026-09-27 08:00", repeat: "none" });
  assert.equal(once.ok, true);
  assert.equal(once.next, "Minggu, 2026-09-27 08:00 WIT");
  assert.match(group.create({ kind: "reminder", text: "x", at: "2026-09-26 20:00", repeat: "none" }).error, /sudah lewat/);
  const weekly = group.create({ kind: "task", text: "cariin jadwal bola minggu ini", at: "2026-09-21 07:00", repeat: "weekly", days: [1] });
  assert.equal(weekly.next, "Senin, 2026-09-28 07:00 WIT", "tanggal lampau untuk jadwal berulang maju ke kejadian berikutnya");
  assert.equal(weekly.repeat, "tiap Senin 07:00");

  const [job] = scheduler.listJobs().filter((j) => j.type === "chat_reminder");
  assert.equal(job.payload.chatId, GROUP, "tujuan = chat asal");
  assert.equal(group.list().schedules.length, 2);
  const other = schedules.forChat({ chatId: OTHER, now: () => NOW });
  assert.match(other.cancel({ id: job.id }).error, /tidak ada di chat ini/);
  assert.equal(group.cancel({ id: job.id }).ok, true);
  assert.equal(group.list().schedules.length, 1);
});

test("jatuh tempo: reminder terkirim ke grup asal, jadwal berulang maju (tidak dihapus), fitur reminder mati = tidak terkirim", async () => {
  reset();
  const group = schedules.forChat({ chatId: GROUP, now: () => NOW });
  group.create({ kind: "reminder", text: "Minum air!", at: "2026-09-26 22:00", repeat: "daily" });
  group.create({ kind: "reminder", text: "Sekali saja", at: "2026-09-26 22:00", repeat: "none" });
  const sock = makeSock();
  const at = NOW + 1.5 * HOUR;
  const results = await scheduler.runDueJobs({ sock, at });
  assert.deepEqual(results.map((r) => r.status), ["sent", "sent"]);
  assert.deepEqual(sock.sent.map((s) => [s.jid, s.text]), [[GROUP, "⏰ Minum air!"], [GROUP, "⏰ Sekali saja"]]);
  const remaining = scheduler.listJobs();
  assert.equal(remaining.length, 1);
  assert.equal(schedules.formatWit(remaining[0].fire_at), "Minggu, 2026-09-27 22:00 WIT");
  assert.ok(groupAgent.getHistory(GROUP).some((e) => e.is_bot && e.text === "⏰ Minum air!"));

  features.setGroupFeature(GROUP, "reminder", false, { role: "admin" });
  const later = await scheduler.runDueJobs({ sock, at: remaining[0].fire_at + 1000 });
  assert.equal(later[0].status, "feature_off");
  assert.equal(sock.sent.length, 2);
});

test("tugas terjadwal menjalankan agent loop dan mengirim hasilnya ke chat asal", async () => {
  reset();
  const mock = await createMockOpenRouter({ chat: ["Jadwal bola minggu ini: *Persipura vs PSM* Sabtu 19.00 WIT."] }).start();
  try {
    schedules.forChat({ chatId: GROUP, now: () => NOW }).create({ kind: "task", text: "cariin jadwal bola minggu ini", at: "2026-09-26 22:00", repeat: "weekly", days: [6] });
    const sock = makeSock();
    const [result] = await scheduler.runDueJobs({ sock, at: NOW + 1.5 * HOUR });
    assert.equal(result.status, "sent");
    assert.equal(sock.sent[0].jid, GROUP);
    assert.match(sock.sent[0].text, /Persipura vs PSM/);
    assert.match(JSON.stringify(mock.state.chat[0].messages), /Tugas terjadwal yang diminta sebelumnya: cariin jadwal bola minggu ini/);
    assert.equal(scheduler.listJobs().length, 1, "mingguan tetap aktif");
  } finally {
    await mock.stop();
  }
});

test("GLM membuat jadwal lewat tool; tujuan tetap chat asal walau model menyebut grup lain", async () => {
  reset();
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("schedule", { kind: "reminder", text: "Rapat grup jam 8 🙌", at: SOON, repeat: "none" })] },
      "Oke, aku ingetin grup ini tanggal 1 Januari jam 08.00 WIT.",
    ],
  }).start();
  try {
    const sock = makeSock();
    await groupAgent.processGroupMessage({ sock, message: { key: { id: "s1", remoteJid: GROUP } }, groupId: GROUP, senderId: PHONE, senderName: "Rehan", text: `@Grad ingetin grup ${OTHER} tahun baru jam 8 buat rapat`, explicitMention: true, replyToBot: false, quotedText: "" });
    const request = mock.state.chat[0];
    assert.ok(request.tools.some((t) => t.function?.name === "schedule"));
    assert.match(request.messages[0].content, /Waktu sekarang: \w+, \d{4}-\d{2}-\d{2} \d{2}:\d{2} WIT/);
    const [job] = scheduler.listJobs();
    assert.equal(job.payload.chatId, GROUP);
    assert.equal(job.payload.createdBy, PHONE);
    assert.match(sock.sent.at(-1).text, /aku ingetin/);
  } finally {
    await mock.stop();
  }
});

test("DM: jadwal dibuat lewat loop dan dikirim ke DM yang di-whitelist saja", async () => {
  reset();
  memoryStore.resetAllMemory();
  memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("schedule", { kind: "reminder", text: "Minum obat ya", at: SOON, repeat: "none" })] },
      "Siap, aku ingetin.",
    ],
  }).start();
  try {
    const sock = makeSock();
    const result = await directAgent.processDirectMessage({ sock, message: { key: { id: "d1", remoteJid: `${PHONE}@s.whatsapp.net` } }, phone: PHONE, senderName: "Rehan", text: "ingetin aku minum obat tahun baru jam 8" });
    assert.equal(result.action, "reply");
    const [job] = scheduler.listJobs();
    assert.deepEqual([job.type, job.payload.chatId, job.payload.isDm], ["chat_reminder", `${PHONE}@s.whatsapp.net`, true]);
    const [sent] = await scheduler.runDueJobs({ sock, at: job.fire_at + 1000 });
    assert.equal(sent.status, "sent");
    assert.equal(sock.sent.at(-1).jid, `${PHONE}@s.whatsapp.net`);

    memoryStore.resetAllMemory();
    schedules.forChat({ chatId: `${PHONE}@s.whatsapp.net`, isDm: true }).create({ kind: "reminder", text: "x", at: SOON, repeat: "none" });
    const [blocked] = await scheduler.runDueJobs({ sock, at: Date.now() + 3 * 24 * HOUR });
    assert.equal(blocked.status, "blocked", "nomor yang keluar dari whitelist tidak dikirimi");
  } finally {
    await mock.stop();
  }
});
