const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-decency-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_DM_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_AGENT_QUIET_START = "0";
process.env.AI_AGENT_QUIET_END = "0";
process.env.STICKER_REACTION_CHANCE = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const decency = require("../ai/agent/decency");
const proactive = require("../ai/agent/proactive");
const features = require("../ai/features");
const { toolNamesFor } = require("../ai/agent/tools");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");

test.after(() => cleanup());

const GROUP = "120363999000333@g.us";
const DIMAS = "628222111000";

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

let counter = 0;
const args = (sock, text, extra = {}) => ({
  sock,
  message: { key: { id: `x${++counter}`, remoteJid: GROUP } },
  groupId: GROUP,
  senderId: DIMAS,
  senderName: "Dimas",
  text,
  explicitMention: false,
  replyToBot: false,
  quotedText: "",
  ...extra,
});

function fresh() {
  proactive.reset();
  decency.reset();
  groupAgent.resetHistories();
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
}

const toolNames = (request) => (request.tools || []).map((t) => t.function?.name || t.type);

test("deteksi kata mesum: huruf berulang & leet tertangkap, kata mirip yang wajar tidak", () => {
  for (const text of ["sange bgt aku", "SANGEEEE", "s4nge", "ada yg punya bokep ga", "open bo kak", "sa perkosa ko kah", "pap tt dong", "konten 18+"]) {
    assert.equal(decency.isLewd(text), true, text);
  }
  for (const text of ["seksi acara siapa", "kerjakan dengan seksama", "memeriksa laporan", "coklat enak", "kotak bekal", "grad hitung untung dong"]) {
    assert.equal(decency.isLewd(text), false, text);
  }
  const now = Date.now();
  const history = [
    { sender_id: "1", text: "sange bgt", at: now - 60_000 },
    { sender_id: "2", text: "wkwk", at: now },
  ];
  assert.deepEqual(decency.lewdContext(history, now), { active: true, latest: false, count: 1, warned: false });
  const afterWarning = [...history, { is_bot: true, sender_id: "BOT", text: "udah ah", at: now }, { sender_id: "1", text: "ayolah sange dikit", at: now }];
  assert.equal(decency.lewdContext(afterWarning, now).warned, true, "Grad sudah bicara setelah pesan mesum pertama");
  assert.match(decency.promptNote(decency.lewdContext(afterWarning, now)), /WAJIB panggil stay_silent/);
  assert.equal(decency.promptNote({ active: false }), "");
  assert.equal(decency.lewdContext(history, now + 30 * 60_000).active, false, "di luar jendela waktu");
});

test("GLM menulis 'stay_silent' sebagai teks (bukan tool call) → tetap diam, tidak terkirim", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "reply", confidence: 0.95 }, chat: ["stay_silent"] }).start();
  try {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(args(sock, "@Grad ceritain yg jorok dong", { explicitMention: true }));
    assert.equal(result.action, "silent");
    assert.equal(sock.sent.length, 0);
  } finally {
    await mock.stop();
  }
});

test("stay_silent tersedia untuk tanggapan langsung, tidak untuk tugas latar/jadwal", () => {
  assert.ok(toolNamesFor({}).includes("stay_silent"));
  assert.ok(!toolNamesFor({ canSilence: false }).includes("stay_silent"));
});

test("tidak dipanggil + obrolan mesum: tanpa reaction tawa, Grad menegur halus sekali lalu cooldown", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "react_laugh", confidence: 0.95 }, opportunity: { choice: "social", confidence: 0.9 }, chat: ["udah ah, ganti topik yuk"] }).start();
  try {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(args(sock, "wkwk dia sange tuh"));
    assert.equal(result.action, "reply");
    assert.equal(result.proactive, "decency");
    assert.equal(sock.sent.filter((item) => item.react).length, 0, "tidak ada reaction 😂");
    const request = mock.state.chat[0];
    assert.match(JSON.stringify(request.messages), /mulai mengarah ke hal seksual/);
    assert.deepEqual(toolNames(request), ["stay_silent"], "teguran hanya teks atau diam");
    assert.equal(sock.sent.at(-1).text, "udah ah, ganti topik yuk");

    const again = await groupAgent.processGroupMessage(args(sock, "bokep mana bokep"));
    assert.equal(again.action, "ignore", "cooldown teguran");
    assert.equal(mock.state.chat.length, 1);
    assert.equal(sock.sent.filter((item) => item.react).length, 0);
  } finally {
    await mock.stop();
  }
});

test("teguran boleh dibatalkan GLM lewat stay_silent: tidak ada yang terkirim", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: [{ content: null, tool_calls: [toolCall("stay_silent", { reason: "bukan_untukku" })] }, "harusnya tidak dipanggil"] }).start();
  try {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(args(sock, "materi biologi bab seks reproduksi besok ya"));
    assert.equal(result.action, "silent");
    assert.equal(result.reason, "bukan_untukku");
    assert.equal(sock.sent.length, 0);
    assert.equal(mock.state.chat.length, 1, "loop berhenti setelah stay_silent");
  } finally {
    await mock.stop();
  }
});

test("dipanggil di tengah obrolan mesum: catatan konteks, tanpa stiker; stay_silent membuang reaction & teks", async () => {
  fresh();
  const mock = await createMockOpenRouter({
    decision: { choice: "reply", confidence: 0.95 },
    chat: [{ content: "wkwk", tool_calls: [toolCall("react", { emoji: "😂" }), toolCall("stay_silent", { reason: "tidak_senonoh" })] }],
  }).start();
  try {
    const sock = makeSock();
    groupAgent.remember(GROUP, { sender: "Yos", senderId: "628333", text: "ngewe yuk wkwk", at: Date.now() });
    const result = await groupAgent.processGroupMessage(args(sock, "@Grad ikutan dong", { explicitMention: true }));
    assert.equal(result.action, "silent");
    const request = mock.state.chat[0];
    assert.match(JSON.stringify(request.messages), /obrolan barusan mengarah ke hal seksual/);
    assert.ok(toolNames(request).includes("stay_silent"));
    assert.ok(!toolNames(request).includes("send_sticker"));
    assert.equal(sock.sent.length, 0, "tanpa teks, tanpa reaction");
  } finally {
    await mock.stop();
  }
});

test("dipanggil di tengah obrolan mesum: reaction tawa dari GLM dibuang, teguran tetap terkirim", async () => {
  fresh();
  const mock = await createMockOpenRouter({
    decision: { choice: "reply", confidence: 0.95 },
    chat: [{ content: "eh topiknya geser dulu dong", tool_calls: [toolCall("react", { emoji: "😂" })] }],
  }).start();
  try {
    const sock = makeSock();
    groupAgent.remember(GROUP, { sender: "Yos", senderId: "628333", text: "sange parah", at: Date.now() });
    const result = await groupAgent.processGroupMessage(args(sock, "@Grad gimana menurutmu", { explicitMention: true }));
    assert.equal(result.action, "reply");
    assert.equal(sock.sent.filter((item) => item.react).length, 0);
    assert.equal(sock.sent.at(-1).text, "eh topiknya geser dulu dong");
  } finally {
    await mock.stop();
  }
});

test("obrolan normal tidak terpengaruh: reaction Jev tetap jalan", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "react_laugh", confidence: 0.95 } }).start();
  try {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(args(sock, "HAHAHA kocak bgt"));
    assert.equal(result.action, "react");
    assert.equal(mock.state.chat.length, 0);
  } finally {
    await mock.stop();
  }
});

test("DM: stay_silent = tidak membalas apa pun", async () => {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  memoryStore.recordParticipant({ phone: DIMAS, name: "Dimas", groupId: GROUP, at: groupAgent.witTimestamp() });
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("stay_silent", { reason: "tidak_senonoh" })] }] }).start();
  try {
    const sock = makeSock();
    const result = await directAgent.processDirectMessage({ sock, message: { key: { id: "dm1" } }, phone: DIMAS, senderName: "Dimas", text: "kirimin bokep dong" });
    assert.equal(result.action, "silent");
    assert.equal(sock.sent.length, 0);
    assert.match(JSON.stringify(mock.state.chat[0].messages), /obrolan barusan mengarah ke hal seksual/);
  } finally {
    await mock.stop();
  }
});
