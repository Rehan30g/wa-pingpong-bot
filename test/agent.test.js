process.env.AI_MEMORY_FILE = "./test/ai-memory-agent.json";
process.env.AGENT_JOBS_FILE = "./test/agent-jobs.json";
process.env.BOT_DATA_FILE = "./test/data-agent.json";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const memoryStore = require("../ai/memory-store");
const humanize = require("../ai/humanize");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const scheduler = require("../ai/scheduler");

const PHONE = "628111111111";
const OTHER = "628222222222";
const GROUP = "120363000000000@g.us";

function makeMockAiServer() {
  const state = { decisions: [], chat: [] };
  const mock = {
    decision: { choice: "reply", confidence: 0.9 },
    intent: { choice: "smalltalk", confidence: 0.9 },
    reply: "Halo, aku di sini.",
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/alpha/decisions") {
        state.decisions.push(JSON.parse(body || "{}"));
        res.end(JSON.stringify({ answers: { action: mock.decision, intent: mock.intent } }));
        return;
      }
      if (req.url === "/api/v1/chat/completions") {
        state.chat.push(JSON.parse(body || "{}"));
        res.end(JSON.stringify({ choices: [{ message: { content: mock.reply } }] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return { state, mock, listen, close };
}

let mockServer;
const oldEnv = {};

async function withMock(run) {
  mockServer = makeMockAiServer();
  oldEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  oldEnv.OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL;
  oldEnv.AI_DM_DEBOUNCE_MS = process.env.AI_DM_DEBOUNCE_MS;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_BASE_URL = await mockServer.listen();
  process.env.AI_DM_DEBOUNCE_MS = "20";
  groupAgent.resetHistories();
  memoryStore.resetAllMemory();
  scheduler.clearJobs();
  try {
    await run(mockServer);
  } finally {
    groupAgent.resetHistories();
    scheduler.clearJobs();
    await mockServer.close();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeSock() {
  const sent = [];
  const reads = [];
  return {
    sent,
    reads,
    sendMessage: async (jid, content, options) => { sent.push({ jid, ...content, options }); return { key: { id: `s${sent.length}` } }; },
    readMessages: async (keys) => reads.push(...keys.map((k) => k.id)),
    sendPresenceUpdate: async () => {},
  };
}

function dmMessage(id) {
  return { key: { id, remoteJid: `${PHONE}@s.whatsapp.net` } };
}

function dmArgs(sock, text, extra = {}) {
  return {
    sock,
    message: dmMessage(extra.id || "m1"),
    phone: PHONE,
    senderName: "Rehan",
    text,
    quotedText: "",
    media: null,
    isOwner: false,
    ...extra,
  };
}

test("memori lama (v1) dimigrasi ke skema v2", () => {
  const migrated = memoryStore.migrate({ groups: { [GROUP]: { glm: "lama", jev: "j", compact_log: ["t"] } } });
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.people, {});
  assert.deepEqual(migrated.relationships, {});
  assert.equal(migrated.groups[GROUP].glm, "lama");
  assert.deepEqual(migrated.groups[GROUP].compact_log, ["t"]);
});

test("registry orang: DM hanya diizinkan setelah pernah chat di grup", () => {
  memoryStore.resetAllMemory();
  assert.equal(memoryStore.canDirectMessage(PHONE), false);

  memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
  assert.equal(memoryStore.canDirectMessage(PHONE), true);
  assert.equal(memoryStore.canDirectMessage(OTHER), false);

  const person = memoryStore.getPerson(`+${PHONE}`);
  assert.equal(person.groups.includes(GROUP), true, "nomor dinormalisasi untuk lookup");
});

test("profil orang dan hubungan disimpan terpisah dari memori grup", () => {
  memoryStore.resetAllMemory();
  memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
  memoryStore.upsertPersonProfile(PHONE, { profile: "suka kopi", relation: "akrab dengan Grad" });
  memoryStore.setRelationship(PHONE, OTHER, { summary: "sahabat" });
  memoryStore.setGroupMemory(GROUP, { glm: "memori grup", jev: "konteks grup" });

  assert.equal(memoryStore.getPerson(PHONE).profile, "suka kopi");
  assert.equal(memoryStore.getRelationship(OTHER, PHONE).summary, "sahabat");
  assert.equal(memoryStore.getGroupMemory(GROUP).glm, "memori grup");
  assert.equal(memoryStore.getDmMemory(PHONE).glm, "Belum ada memori DM.");
});

test("merge profil dan hubungan tidak menghapus memori lama", () => {
  memoryStore.resetAllMemory();
  memoryStore.upsertPersonProfile(PHONE, { profile: "suka kopi", relation: "kenal dari grup A" });
  memoryStore.upsertPersonProfile(PHONE, { profile: "bekerja malam", relation: "aktif di grup B", merge: true });
  memoryStore.setRelationship(PHONE, OTHER, { summary: "teman sekolah" });
  memoryStore.setRelationship(PHONE, OTHER, { summary: "sering diskusi coding", merge: true });

  assert.match(memoryStore.getPerson(PHONE).profile, /suka kopi/);
  assert.match(memoryStore.getPerson(PHONE).profile, /bekerja malam/);
  assert.match(memoryStore.getRelationship(PHONE, OTHER).summary, /teman sekolah/);
  assert.match(memoryStore.getRelationship(PHONE, OTHER).summary, /diskusi coding/);
});

test("deteksi permintaan broadcast dan pesan pribadi biasa", () => {
  assert.equal(humanize.detectBroadcastIntent("tolong sebarkan ke semua orang"), true);
  assert.equal(humanize.detectBroadcastIntent("bilang ke semua kalau acara batal"), true);
  assert.equal(humanize.detectBroadcastIntent("kabari semua anggota ya"), true);
  assert.equal(humanize.detectBroadcastIntent("broadcast pesan ini"), true);
  assert.equal(humanize.detectBroadcastIntent("kamu lagi apa?"), false);
  assert.equal(humanize.detectBroadcastIntent("menurutmu warna apa yang cocok?"), false);
});

test("deteksi opt-out dan menghitung waktu reminder", () => {
  assert.equal(humanize.detectOptOut("jangan chat aku dulu"), true);
  assert.equal(humanize.detectOptOut("stop gangguin"), true);
  assert.equal(humanize.detectOptOut("kamu lucu"), false);

  const now = Date.now();
  const minute = humanize.parseReminderRequest("ingetin aku 15 menit lagi minum obat", now);
  assert.ok(minute && minute.fireAt >= now + 14 * 60_000 && minute.fireAt <= now + 16 * 60_000);

  const hours = humanize.parseReminderRequest("remind aku 2 jam lagi telepon mama", now);
  assert.ok(hours && hours.fireAt >= now + 119 * 60_000);

  assert.equal(humanize.parseReminderRequest("kamu lagi apa?", now), null);
});

test("jam tenang dan pemecahan balasan panjang", () => {
  const quietAt = humanize.witEpochAt(23, 0);
  assert.equal(humanize.isQuietHours(quietAt, { start: 22, end: 7 }), true);
  const busyAt = humanize.witEpochAt(10, 0);
  assert.equal(humanize.isQuietHours(busyAt, { start: 22, end: 7 }), false);

  const long = "Kalimat pertama yang cukup panjang untuk memicu pemecahan pesan ini. Kalimat kedua juga panjang supaya melewati ambang batas yang ditentukan di sini.";
  assert.equal(humanize.splitReply(long, { threshold: 40 }).length, 2);
});

test("DM dari nomor di luar whitelist diabaikan total", async () => {
  await withMock(async () => {
    const sock = makeSock();
    const result = await directAgent.processDirectMessage(dmArgs(sock, "halo bot"));
    assert.equal(result.action, "blocked");
    assert.equal(sock.sent.length, 0, "orang asing tidak boleh dibalas");
    assert.equal(mockServer.state.decisions.length, 0, "tidak boleh memanggil Jev untuk orang asing");
  });
});

test("DM dari orang dikenal dibalas meski confidence Jev rendah", async () => {
  await withMock(async (mock) => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    mock.mock.decision = { choice: "reply", confidence: 0.35 };
    const sock = makeSock();
    const result = await directAgent.processDirectMessage(dmArgs(sock, "menurutmu aku harus mulai dari mana?"));
    assert.equal(result.action, "reply");
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, `${PHONE}@s.whatsapp.net`);
    assert.equal(sock.reads.length, 1, "read receipt dikirim");
  });
});

test("DM ignore hanya ketika Jev sangat yakin dan bukan spam", async () => {
  await withMock(async (mock) => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    mock.mock.decision = { choice: "ignore", confidence: 0.95 };
    mock.mock.intent = { choice: "smalltalk", confidence: 0.95 };
    const sock = makeSock();
    const result = await directAgent.processDirectMessage(dmArgs(sock, "oke"));
    assert.equal(result.action, "ignore");
    assert.equal(sock.sent.length, 0);
  });
});

test("permintaan menyebarkan pesan ditolak dan tidak menyentuh nomor lain", async () => {
  await withMock(async (mock) => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    mock.mock.intent = { choice: "broadcast_request", confidence: 0.95 };
    const sock = makeSock();
    const result = await directAgent.processDirectMessage(dmArgs(sock, "tolong kabari semua anggota kalau rapat batal"));
    assert.equal(result.action, "refused");
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, `${PHONE}@s.whatsapp.net`, "hanya membalas pengirim, bukan menyebar");
    assert.match(sock.sent[0].text, /nggak bisa dipakai buat nyebarin/i);
    assert.equal(mockServer.state.chat.length, 0, "tidak memanggil GLM untuk penyebaran");
  });
});

test("opt-out dari pengguna menghentikan DM proaktif", async () => {
  await withMock(async () => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    const sock = makeSock();
    await directAgent.processDirectMessage(dmArgs(sock, "jangan chat aku dulu"));
    assert.equal(memoryStore.getDmMemory(PHONE).opt_out, true);
    assert.equal(scheduler.canProactivelyMessage(PHONE, Date.now()), false);
  });
});

test("riwayat DM terpisah dari riwayat grup", async () => {
  await withMock(async () => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    groupAgent.remember(GROUP, { sender: "Budi", senderId: OTHER, text: "pesan grup" });
    const sock = makeSock();
    await directAgent.processDirectMessage(dmArgs(sock, "halo, ini dm"));

    assert.deepEqual(groupAgent.getHistory(GROUP).map((x) => x.text), ["pesan grup"]);
    const dmHistory = groupAgent.getHistory(`dm:${PHONE}`);
    assert.ok(dmHistory.some((x) => x.text === "halo, ini dm"));
    assert.ok(dmHistory.some((x) => x.is_bot && x.text === "Halo, aku di sini."));
  });
});

test("DM mengirim ulang media lama dan dapat memilih pesan yang dikutip", async () => {
  await withMock(async (mock) => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP });
    mock.mock.reply = JSON.stringify({ text: "Aku lihat gambarnya", reply_to_entry_id: null });
    const sock = makeSock();
    await directAgent.processDirectMessage(dmArgs(sock, "lihat ini", {
      id: "dm-image",
      media: { type: "image", kind: "attachment", format: "image", dataUrl: "data:image/jpeg;base64,RE0=" },
    }));
    const target = groupAgent.getHistory(`dm:${PHONE}`).find((item) => item.text === "lihat ini");

    mock.mock.reply = JSON.stringify({ text: "Yang ini ya", reply_to_entry_id: target.entry_id });
    await directAgent.processDirectMessage(dmArgs(sock, "yang tadi gimana?", { id: "dm-followup" }));

    const secondRequest = mock.state.chat[1].messages.at(-1).content;
    assert.ok(Array.isArray(secondRequest));
    assert.ok(secondRequest.some((part) => part.type === "image_url"));
    assert.equal(sock.sent[1].options.quoted.key.id, "dm-image");
  });
});

test("status agent on/off tersimpan persisten", () => {
  memoryStore.resetAllMemory();
  const oldEnabled = process.env.AI_AGENT_ENABLED;
  process.env.AI_AGENT_ENABLED = "true";
  scheduler.setEnabled(false);
  assert.equal(memoryStore.getAgentSettings().enabled, false);
  assert.equal(scheduler.agentConfig().enabled, false, "setting tersimpan harus mengalahkan default env");
  scheduler.setEnabled(true);
  if (oldEnabled === undefined) delete process.env.AI_AGENT_ENABLED;
  else process.env.AI_AGENT_ENABLED = oldEnabled;
});

test("gerbang DM proaktif: whitelist, jam tenang, dan batas harian", () => {
  memoryStore.resetAllMemory();
  const busyAt = humanize.witEpochAt(10, 0);
  const oldQuiet = { start: process.env.AI_AGENT_QUIET_START, end: process.env.AI_AGENT_QUIET_END, limit: process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT, proactive: process.env.AI_AGENT_PROACTIVE };
  process.env.AI_AGENT_QUIET_START = "22";
  process.env.AI_AGENT_QUIET_END = "7";
  process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT = "5";
  process.env.AI_AGENT_PROACTIVE = "true";

  assert.equal(scheduler.canProactivelyMessage(PHONE, busyAt), false, "belum dikenal");
  memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
  assert.equal(scheduler.canProactivelyMessage(PHONE, busyAt), true);
  assert.equal(scheduler.isRecentlyActive(PHONE, Date.now()), true);

  const quietAt = humanize.witEpochAt(23, 0);
  assert.equal(scheduler.canProactivelyMessage(PHONE, quietAt), false, "jam tenang memblokir");

  process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT = "0";
  assert.equal(scheduler.canProactivelyMessage(PHONE, busyAt), false, "batas harian");

  for (const [key, value] of Object.entries({ AI_AGENT_QUIET_START: oldQuiet.start, AI_AGENT_QUIET_END: oldQuiet.end, AI_AGENT_DAILY_PROACTIVE_LIMIT: oldQuiet.limit, AI_AGENT_PROACTIVE: oldQuiet.proactive })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("job reminder terkirim walau DM proaktif dimatikan", async () => {
  await withMock(async () => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
    const oldProactive = process.env.AI_AGENT_PROACTIVE;
    process.env.AI_AGENT_PROACTIVE = "false";
    const sock = makeSock();
    scheduler.scheduleJob({ type: "reminder", fire_at: Date.now() - 1000, payload: { phone: PHONE, text: "minum obat" } });
    const results = await scheduler.runDueJobs({ sock, at: Date.now() });
    assert.equal(results[0].status, "sent");
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, `${PHONE}@s.whatsapp.net`);
    assert.equal(sock.sent[0].text, "minum obat");
    if (oldProactive === undefined) delete process.env.AI_AGENT_PROACTIVE;
    else process.env.AI_AGENT_PROACTIVE = oldProactive;
  });
});

test("job proactive_checkin memakai gerbang aman dan mencatat kuota", async () => {
  await withMock(async (mock) => {
    memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
    mock.mock.reply = "Hai, apa kabar? Semoga harimu lancar.";
    const oldQuiet = { start: process.env.AI_AGENT_QUIET_START, end: process.env.AI_AGENT_QUIET_END, limit: process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT, proactive: process.env.AI_AGENT_PROACTIVE };
    process.env.AI_AGENT_QUIET_START = "22";
    process.env.AI_AGENT_QUIET_END = "7";
    process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT = "5";
    process.env.AI_AGENT_PROACTIVE = "true";

    const at = humanize.witEpochAt(10, 0);
    const sock = makeSock();
    scheduler.scheduleJob({ type: "proactive_checkin", fire_at: at - 1000, payload: { phone: PHONE } });
    const results = await scheduler.runDueJobs({ sock, at });
    assert.equal(results[0].status, "sent");
    assert.equal(sock.sent.length, 1);
    assert.equal(scheduler.todayProactiveCount(at), 1);

    if (oldQuiet.start === undefined) delete process.env.AI_AGENT_QUIET_START; else process.env.AI_AGENT_QUIET_START = oldQuiet.start;
    if (oldQuiet.end === undefined) delete process.env.AI_AGENT_QUIET_END; else process.env.AI_AGENT_QUIET_END = oldQuiet.end;
    if (oldQuiet.limit === undefined) delete process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT; else process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT = oldQuiet.limit;
    if (oldQuiet.proactive === undefined) delete process.env.AI_AGENT_PROACTIVE; else process.env.AI_AGENT_PROACTIVE = oldQuiet.proactive;
  });
});

test("job untuk nomor di luar whitelist diblokir", async () => {
  await withMock(async () => {
    memoryStore.resetAllMemory();
    const sock = makeSock();
    scheduler.scheduleJob({ type: "reminder", fire_at: Date.now() - 1000, payload: { phone: OTHER, text: "hai" } });
    const results = await scheduler.runDueJobs({ sock, at: Date.now() });
    assert.equal(results[0].status, "blocked");
    assert.equal(sock.sent.length, 0);
  });
});
