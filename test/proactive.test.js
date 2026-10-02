const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-proactive-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_AGENT_QUIET_START = "0";
process.env.AI_AGENT_QUIET_END = "0"; // tanpa jam tenang kecuali tes khusus

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const proactive = require("../ai/agent/proactive");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");
const humanize = require("../ai/humanize");

test.after(() => cleanup());

const GROUP = "120363999000111@g.us";
const MIN = 60_000;

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
  message: { key: { id: `p${++counter}`, remoteJid: GROUP } },
  groupId: GROUP,
  senderId: "628222333444",
  senderName: "Kevin",
  text,
  explicitMention: false,
  replyToBot: false,
  quotedText: "",
  ...extra,
});

// Grup "ramai": syarat nimbrung sosial sejak 27 Sep (≥4 pesan manusia dari ≥2 orang, 10 menit).
function liven(groupId = GROUP) {
  for (const [name, id, text] of [["Kevin", "628777", "eh tadi seru banget"], ["Rehan", "628111", "iya wkwk"], ["Kevin", "628777", "besok lagi yuk"], ["Rehan", "628111", "gas"]]) {
    groupAgent.remember(groupId, { sender: name, senderId: id, text });
  }
}

function fresh() {
  proactive.reset();
  groupAgent.resetHistories();
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
}

test("panggilan nama toleran: Gradd/GRAAAD/grad2 terbaca, Grab/gratis/gradasi tidak", () => {
  for (const text of ["Gradd besok rapat jam brp", "GRAAAD!!", "grad2 sini", "woi gradd", "halo grad?"]) assert.equal(groupAgent.textMentionsBotName(text, "Grad"), true, text);
  for (const text of ["pesan grab aja", "gratis ongkir", "gradasi warnanya", "upgrade dulu", "grade A"]) assert.equal(groupAgent.textMentionsBotName(text, "Grad"), false, text);
});

test("default nimbrung jarang: cooldown 60 menit, maks 1/jam, dan hanya saat grup ramai", () => {
  fresh();
  const cfg = proactive.proactiveConfig();
  assert.deepEqual([cfg.socialCooldownMs / MIN, cfg.socialMaxPerHour], [60, 1]);
  const t = Date.now();
  const chat = (n, senders) => Array.from({ length: n }, (_, i) => ({ sender_id: `6281${i % senders}`, at: t - i * MIN, is_bot: false }));
  assert.equal(proactive.checkSocial(GROUP, t, { history: chat(2, 2) }).reason, "grup_sepi", "baru 2 pesan");
  assert.equal(proactive.checkSocial(GROUP, t, { history: chat(6, 1) }).reason, "grup_sepi", "cuma satu orang ngomong sendiri");
  assert.equal(proactive.checkSocial(GROUP, t, { history: chat(4, 2).map((item) => ({ ...item, at: t - 30 * MIN })) }).reason, "grup_sepi", "ramainya sudah lewat");
  assert.equal(proactive.checkSocial(GROUP, t, { history: chat(4, 2) }).ok, true);
});

test("rem proaktif: cooldown bantuan, cooldown & kuota sosial, jam tenang, dan 'diam'", () => {
  fresh();
  process.env.AGENT_SOCIAL_COOLDOWN_MIN = "20";
  process.env.AGENT_SOCIAL_MAX_PER_HOUR = "2";
  test.after(() => { delete process.env.AGENT_SOCIAL_COOLDOWN_MIN; delete process.env.AGENT_SOCIAL_MAX_PER_HOUR; });
  const t = Date.now();
  assert.equal(proactive.checkHelp(GROUP, t).ok, true);
  proactive.markHelp(GROUP, t);
  assert.equal(proactive.checkHelp(GROUP, t + MIN).reason, "cooldown");
  assert.equal(proactive.checkHelp(GROUP, t + 2 * MIN).ok, true);

  proactive.markSocial(GROUP, t);
  assert.equal(proactive.checkSocial(GROUP, t + 10 * MIN).reason, "cooldown");
  proactive.markSocial(GROUP, t + 25 * MIN);
  assert.equal(proactive.checkSocial(GROUP, t + 50 * MIN).reason, "hourly_limit");
  assert.equal(proactive.checkSocial(GROUP, t + 90 * MIN).ok, true);

  process.env.AI_AGENT_QUIET_START = "22";
  process.env.AI_AGENT_QUIET_END = "7";
  try {
    assert.equal(proactive.checkSocial("120363999000222@g.us", humanize.witEpochAt(23, 0)).reason, "quiet_hours");
    assert.equal(proactive.checkHelp("120363999000222@g.us", humanize.witEpochAt(23, 0)).ok, true, "bantuan tetap boleh di jam tenang");
  } finally {
    process.env.AI_AGENT_QUIET_START = "0";
    process.env.AI_AGENT_QUIET_END = "0";
  }

  for (const text of ["grad diem dulu", "@Grad jangan nimbrung", "Gradd berisik ih", "grad ga usah ikut"]) assert.equal(proactive.isMuteRequest(text, { addressed: true }), true, text);
  assert.equal(proactive.isMuteRequest("diem dulu kalian", { addressed: false }), false, "harus ditujukan ke bot");
  assert.equal(proactive.isMuteRequest("grad, diam-diam dia udah jadian loh", { addressed: true }), true);
  proactive.mute(GROUP, t);
  assert.equal(proactive.checkHelp(GROUP, t + 5 * MIN).reason, "muted");
});

test("jalur bantuan: tidak dipanggil tapi ada pertanyaan terbuka → Grad membantu singkat, lalu cooldown", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.8 }, opportunity: { choice: "help", confidence: 0.85 }, chat: ["Rapatnya besok jam 10 di ruang 2."] }).start();
  try {
    const sock = makeSock();
    const first = await groupAgent.processGroupMessage(args(sock, "eh ada yang tau rapat besok jam berapa?"));
    assert.equal(first.action, "reply");
    assert.equal(first.proactive, "help");
    assert.match(JSON.stringify(mock.state.chat[0].messages), /kamu TIDAK dipanggil\. Kamu masuk sendiri karena ada bantuan nyata/);
    assert.ok(mock.state.chat[0].tools.some((t) => t.type === "openrouter:web_search"), "bantuan boleh memakai web");
    assert.equal(sock.sent.at(-1).text, "Rapatnya besok jam 10 di ruang 2.");
    const second = await groupAgent.processGroupMessage(args(sock, "terus tempatnya di mana ya?"));
    assert.equal(second.action, "ignore", "cooldown bantuan 2 menit");
    assert.equal(mock.state.chat.length, 1);
  } finally {
    await mock.stop();
  }
});

test("jalur sosial: hanya stiker/teks singkat tanpa web; jawaban kosong = diam; fitur sosial mati = tidak masuk", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.7 }, opportunity: { choice: "social", confidence: 0.8 }, chat: [""] }).start();
  try {
    const sock = makeSock();
    liven();
    const result = await groupAgent.processGroupMessage(args(sock, "wkwk kemarin aku kepleset di depan kelas"));
    assert.equal(result.action, "proactive_skip");
    const request = mock.state.chat[0];
    assert.ok(!(request.tools || []).some((t) => t.type === "openrouter:web_search" || ["web_fetch", "schedule", "remember"].includes(t.function?.name)));
    assert.match(JSON.stringify(request.messages), /grup lagi rame dan santai/);
    assert.equal(sock.sent.length, 0, "tidak ada yang pas → tidak mengirim apa-apa (tanpa 'Maaf…')");

    proactive.reset();
    features.setGroupFeature(GROUP, "sosial", false, { role: "admin" });
    await groupAgent.processGroupMessage(args(sock, "wkwk lagi dong ceritanya"));
    assert.equal(mock.state.chat.length, 1, "sosial mati → GLM tidak dipanggil");
  } finally {
    await mock.stop();
  }
});

test("reaction yang pas lebih diutamakan daripada nimbrung", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "react_laugh", confidence: 0.9 }, opportunity: { choice: "social", confidence: 0.9 } }).start();
  try {
    await withChance(0, async () => {
      const sock = makeSock();
      const result = await groupAgent.processGroupMessage(args(sock, "HAHAHA"));
      assert.equal(result.action, "react");
      assert.equal(mock.state.chat.length, 0);
    });
  } finally {
    await mock.stop();
  }
});

test("'grad diem dulu' mematikan jalur proaktif, tapi panggilan langsung tetap dijawab", async () => {
  fresh();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.8 }, opportunity: { choice: "help", confidence: 0.9 }, chat: ["Iya, aku di sini."] }).start();
  try {
    const sock = makeSock();
    const muted = await groupAgent.processGroupMessage(args(sock, "grad diem dulu ya", { explicitMention: true }));
    assert.equal(muted.action, "muted");
    assert.equal(sock.sent.at(-1).react.text, "🤐");
    const later = await groupAgent.processGroupMessage(args(sock, "ada yang tau harga emas hari ini?"));
    assert.equal(later.action, "ignore");
    mock.script.decision = { choice: "reply", confidence: 0.9 };
    const openQuestion = await groupAgent.processGroupMessage(args(sock, "siapapun jawab dong, rapat jam berapa?"));
    assert.equal(openQuestion.action, "ignore", "Jev memilih reply pun tetap ditahan selama diminta diam");
    assert.equal(mock.state.chat.length, 0);
    const direct = await groupAgent.processGroupMessage(args(sock, "@Grad kamu masih di situ?", { explicitMention: true }));
    assert.equal(direct.action, "reply");
  } finally {
    await mock.stop();
  }
});

test("nimbrung sosial boleh memakai stiker koleksi", async () => {
  fresh();
  const sharp = require("sharp");
  const { resetStickerCollector, getStickerCollector } = require("../ai/stickers/collector");
  const { getStickerLibrary } = require("../ai/stickers/library");
  await resetStickerCollector();
  process.env.STICKER_DIR = require("node:path").join(require("node:os").tmpdir(), `grad-proactive-st-${Date.now()}`);
  const buffer = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 250, g: 200, b: 0, alpha: 1 } } }).webp().toBuffer();
  const sha = Buffer.alloc(32, 5);
  await getStickerCollector().observe({ chatId: GROUP, senderName: "Kevin", sticker: { fileSha256: sha }, download: async () => buffer });
  await getStickerLibrary().keep(sha.toString("hex"), { label: "ngakak", moods: ["laugh"], when_to_use: "lucu", planned_frequency: "sering", scope: "global", reason: "tes" });
  const mock = await createMockOpenRouter({
    decision: { choice: "ignore", confidence: 0.7 },
    opportunity: { choice: "social", confidence: 0.8 },
    chat: [{ content: null, tool_calls: [toolCall("send_sticker", { sticker_id: sha.toString("hex").slice(0, 8), placement: "only" })] }, "wkwk"],
  }).start();
  try {
    const sock = makeSock();
    liven();
    const result = await groupAgent.processGroupMessage(args(sock, "wkwk si Rehan kepleset lagi"));
    assert.equal(result.action, "sticker");
    assert.equal(result.proactive, "social");
    assert.deepEqual(sock.sent.map((s) => (s.sticker ? "STIKER" : s.text)), ["STIKER"]);
  } finally {
    await mock.stop();
    await resetStickerCollector();
  }
});

async function withChance(value, run) {
  const old = process.env.STICKER_REACTION_CHANCE;
  process.env.STICKER_REACTION_CHANCE = String(value);
  try {
    return await run();
  } finally {
    if (old === undefined) delete process.env.STICKER_REACTION_CHANCE;
    else process.env.STICKER_REACTION_CHANCE = old;
  }
}
