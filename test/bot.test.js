const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-bot-");
// AI dianggap terkonfigurasi, tetapi panggilan yang lolos gagal cepat tanpa jaringan.
process.env.OPENROUTER_API_KEY = "test-key-no-network";
process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9";
process.env.OPENROUTER_MAX_RETRIES = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const bot = require("../index.js");

test.after(() => {
  cleanup();
});

const GROUP = "120363000000000@g.us";
const OWNER = "628111111111";
const PLAYER = "628222222222";

function makeSock({ participants = [] } = {}) {
  const sent = [];
  const reads = [];
  return {
    sent,
    reads,
    sendMessage: async (jid, content) => {
      sent.push({ jid, text: content.text });
      return { key: { id: "x" } };
    },
    readMessages: async (keys) => reads.push(...keys),
    sendPresenceUpdate: async () => {},
    groupMetadata: async (jid) => ({ subject: "Grup Test", participants }),
  };
}

function msg({
  chat = GROUP,
  from = PLAYER,
  text,
  pushName = "Tester",
  contextInfo = null,
  participant,
  participantAlt,
  participantPn,
}) {
  return {
    key: {
      remoteJid: chat,
      fromMe: false,
      participant: chat.endsWith("@g.us") ? (participant || `${from}@s.whatsapp.net`) : undefined,
      participantAlt,
      participantPn,
    },
    pushName,
    message: contextInfo
      ? { extendedTextMessage: { text, contextInfo } }
      : { conversation: text },
  };
}

const last = (sock) => sock.sent[sock.sent.length - 1];
const reset = (owner = null, groups = []) => {
  bot.resetData();
  const d = bot.getData();
  d.owner = owner;
  d.allowedGroups = groups;
  bot.games.clear();
};

test("/task adalah alias: isinya masuk agent loop dengan tools di grup dan DM", async () => {
  const { createMockOpenRouter } = require("./helpers/mock-openrouter");
  const mock = await createMockOpenRouter({ chat: ["Siap, rapatnya Jumat jam 9 WIT."] }).start();
  const oldDebounce = [process.env.AI_DEBOUNCE_MS, process.env.AI_DM_DEBOUNCE_MS, process.env.AI_HUMAN_DELAY_SCALE];
  process.env.AI_DEBOUNCE_MS = "0";
  process.env.AI_DM_DEBOUNCE_MS = "0";
  process.env.AI_HUMAN_DELAY_SCALE = "0";
  try {
    reset(OWNER, [GROUP]);
    bot.groupAgent.resetHistories();
    const sock = makeSock();
    bot.setSock(sock);
    await bot.dispatchInboundMessage(msg({ text: "/task cari jadwal rapat Jumat" }), { sock });
    assert.equal(mock.state.decisions[0].state.signals.explicit_mention, true, "/task dianggap ditujukan ke bot");
    const request = mock.state.chat[0];
    assert.ok(request.tools.some((tool) => tool.type === "openrouter:web_search"), "web search bawaan OpenRouter terpasang");
    assert.ok(request.tools.some((tool) => tool.function?.name === "web_fetch"));
    assert.match(JSON.stringify(request.messages), /cari jadwal rapat Jumat/);
    assert.doesNotMatch(JSON.stringify(request.messages), /\/task/);
    assert.equal(last(sock).text, "Siap, rapatnya Jumat jam 9 WIT.");

    await bot.dispatchInboundMessage(msg({ text: "/task" }), { sock });
    assert.match(last(sock).text, /Tulis permintaannya setelah \/task/);

    // DM owner: /task tidak lagi dibuang sebagai command tak dikenal.
    await bot.dispatchInboundMessage(msg({ chat: `${OWNER}@s.whatsapp.net`, from: OWNER, text: "/task rapat Jumat jam 9 WIT" }), { sock });
    assert.equal(mock.state.chat.length, 2);
    assert.equal(last(sock).jid, `${OWNER}@s.whatsapp.net`);
  } finally {
    [process.env.AI_DEBOUNCE_MS, process.env.AI_DM_DEBOUNCE_MS, process.env.AI_HUMAN_DELAY_SCALE] = oldDebounce.map((v) => v ?? "");
    await mock.stop();
  }
});

test("/verify membuat kode dan menunggu input terminal", async () => {
  reset();
  const sock = makeSock();
  bot.setSock(sock);

  await bot.handleMessage(msg({ text: "/verify" }));

  const pv = bot.getPendingVerify();
  assert.ok(pv, "pendingVerify harus terisi");
  assert.match(pv.code, /^\d{6}$/, "kode harus 6 digit");
  assert.equal(pv.userJid, PLAYER);
  assert.match(last(sock).text, /Kode verifikasi/);
});

test("kode salah ditolak, owner belum diset", async () => {
  reset();
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/verify" }));
  const pv = bot.getPendingVerify();

  const result = bot.handleCodeInput("000000");
  assert.match(result, /Kode salah/);
  assert.equal(bot.getData().owner, null);
  assert.ok(bot.getPendingVerify(), "sesi verifikasi masih terbuka");

  // kode yang benar diterima
  const result2 = bot.handleCodeInput(pv.code);
  assert.match(result2, /Berhasil/);
  assert.equal(bot.getData().owner, PLAYER);
  assert.equal(bot.getPendingVerify(), null);
  assert.ok(sock.sent.some((s) => s.text.includes("Verifikasi berhasil")));
  assert.ok(JSON.parse(fs.readFileSync(process.env.BOT_DATA_FILE, "utf8")).owner === PLAYER, "owner tersimpan di file");
});

test("input tanpa sesi verifikasi -> ditolak", async () => {
  reset();
  bot.setPendingVerify(null);
  assert.match(bot.handleCodeInput("123456"), /Tidak ada permintaan/);
});

test("kode kedaluwarsa ditolak", async () => {
  reset();
  bot.setPendingVerify({ code: "123456", userJid: PLAYER, sendJid: `${PLAYER}@s.whatsapp.net`, userName: "+x", expires: Date.now() - 1000 });
  assert.match(bot.handleCodeInput("123456"), /kedaluwarsa/);
  assert.equal(bot.getPendingVerify(), null);
});

test("/allow oleh bukan owner ditolak", async () => {
  reset();
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/allow" }));
  assert.match(last(sock).text, /Hanya owner/);
  assert.deepEqual(bot.getData().allowedGroups, []);
});

test("/allow oleh owner di chat pribadi ditolak (harus di grup)", async () => {
  reset(OWNER);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ chat: `${OWNER}@s.whatsapp.net`, from: OWNER, text: "/allow" }));
  assert.match(last(sock).text, /hanya bisa dipakai di dalam grup/);
});

test("/allow oleh owner di grup mengaktifkan bot", async () => {
  reset(OWNER);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ from: OWNER, text: "/allow" }));
  assert.ok(bot.getData().allowedGroups.includes(GROUP));
  assert.match(last(sock).text, /AKTIF/);
  assert.ok(JSON.parse(fs.readFileSync(process.env.BOT_DATA_FILE, "utf8")).allowedGroups.includes(GROUP));
});

test("pesan diabaikan di grup yang belum di-allow", async () => {
  reset(OWNER);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "ping" }));
  assert.equal(sock.sent.length, 0, "tidak boleh ada balasan");
});

test("/deny oleh owner menonaktifkan grup", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ from: OWNER, text: "/deny" }));
  assert.ok(!bot.getData().allowedGroups.includes(GROUP));
  assert.match(last(sock).text, /NONAKTIF/);
});

test("ping tanpa game dibalas pong", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "ping" }));
  assert.match(last(sock).text, /pong/);
});

test("/start memulai game, pong memukul, rally bertambah", async () => {
  const origRandom = Math.random;
  Math.random = () => 0.01; // selalu sukses
  try {
    reset(OWNER, [GROUP]);
    const sock = makeSock();
    bot.setSock(sock);
    await bot.handleMessage(msg({ from: OWNER, text: "/start" }));
    assert.match(last(sock).text, /DIMULAI/);
    await bot.handleMessage(msg({ text: "pong", pushName: "Andi" }));
    assert.match(last(sock).text, /rally ke-1 oleh Andi/);
    await bot.handleMessage(msg({ text: "pong", pushName: "Andi" }));
    assert.match(last(sock).text, /rally ke-2/);
    assert.equal(bot.games.get(GROUP).rally, 2);
  } finally {
    Math.random = origRandom;
  }
});

test("/start saat game berjalan -> peringatan", async () => {
  reset(OWNER, [GROUP]);
  bot.games.set(GROUP, { ball: 0, rally: 1, scores: {} });
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/start" }));
  assert.match(last(sock).text, /masih berjalan/);
});

test("rally > 2 dengan random < 0.25 -> bola lewat, skor bertambah", async () => {
  const origRandom = Math.random;
  Math.random = () => 0.01; // di bawah 25% -> gagal
  try {
    reset(OWNER, [GROUP]);
    bot.games.set(GROUP, { ball: 0, rally: 2, active: true, scores: {} });
    const sock = makeSock();
    bot.setSock(sock);
    await bot.handleMessage(msg({ text: "pong", pushName: "Budi" }));
    const g = bot.games.get(GROUP);
    assert.equal(g.rally, 0, "rally reset setelah bola lewat");
    assert.equal(g.scores[PLAYER].score, 1, "dapat 1 poin (floor(3/2))");
    assert.match(last(sock).text, /BOLA LEWAT/);
    assert.match(last(sock).text, /Budi dapat 1 poin/);
  } finally {
    Math.random = origRandom;
  }
});

test("2 pukulan gagal -> poin menumpuk", async () => {
  const origRandom = Math.random;
  Math.random = () => 0.01;
  try {
    reset(OWNER, [GROUP]);
    bot.games.set(GROUP, { ball: 0, rally: 2, active: true, scores: { [PLAYER]: { name: "Budi", score: 2 } } });
    const sock = makeSock();
    bot.setSock(sock);
    await bot.handleMessage(msg({ text: "pong", pushName: "Budi" }));
    assert.equal(bot.games.get(GROUP).scores[PLAYER].score, 3);
  } finally {
    Math.random = origRandom;
  }
});

test("/score menampilkan papan skor", async () => {
  reset(OWNER, [GROUP]);
  bot.games.set(GROUP, { ball: 0, rally: 0, scores: { [PLAYER]: { name: "Budi", score: 5 }, "628333": { name: "Cici", score: 7 } } });
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/score" }));
  const t = last(sock).text;
  assert.match(t, /PAPAN SKOR/);
  assert.match(t, /1\. Cici — 7 poin/); // diurutkan menurun
  assert.match(t, /2\. Budi — 5 poin/);
});

test("/score tanpa data -> pesan kosong", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/score" }));
  assert.match(last(sock).text, /Belum ada skor/);
});

test("/stop menghentikan game", async () => {
  reset(OWNER, [GROUP]);
  bot.games.set(GROUP, { ball: 0, rally: 3, scores: {} });
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "/stop" }));
  assert.ok(!bot.games.has(GROUP));
  assert.match(last(sock).text, /dihentikan/);
});

test("/owner menampilkan status owner", async () => {
  reset(OWNER);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ chat: `${PLAYER}@s.whatsapp.net`, from: PLAYER, text: "/owner" }));
  assert.match(last(sock).text, new RegExp(OWNER));
});

test("case-insensitive: 'PING' juga dibalas pong", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage(msg({ text: "PING" }));
  assert.match(last(sock).text, /pong/);
});

test("/reboot oleh bukan owner ditolak", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  let rebooted = false;
  bot.setReboot(() => { rebooted = true; });
  await bot.handleMessage(msg({ from: PLAYER, text: "/reboot" }));
  assert.match(last(sock).text, /Hanya owner/);
  assert.equal(rebooted, false);
});

test("/reboot oleh owner memicu restart", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  reset(OWNER);
  const sock = makeSock();
  bot.setSock(sock);
  let rebooted = false;
  bot.setReboot(() => { rebooted = true; });
  bot.setRebootDelay(10);
  await bot.handleMessage(msg({ chat: `${OWNER}@s.whatsapp.net`, from: OWNER, text: "/reboot" }));
  assert.match(last(sock).text, /di-restart/);
  await sleep(50);
  assert.equal(rebooted, true, "reboot harus tereksekusi");
  bot.setRebootDelay(1500);
  bot.setReboot(bot.realReboot);
});

test("pesan tanpa teks diabaikan", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);
  await bot.handleMessage({ key: { remoteJid: GROUP, fromMe: false, participant: `${PLAYER}@s.whatsapp.net` }, message: { imageMessage: {} } });
  assert.equal(sock.sent.length, 0);
  assert.equal(sock.reads.length, 0, "read receipt hanya saat Jev merespons");
});

test("nomor PN diprioritaskan daripada participant LID", () => {
  const m = {
    key: {
      participant: "123456789012345@lid",
      participantPn: "6285212345678@s.whatsapp.net",
    },
  };
  assert.equal(bot.getSenderNumber(m, true, GROUP), "6285212345678");
  assert.equal(bot.phoneIdentity("6285212345678"), "+6285212345678 (085212345678)");
});

function setBotUser(user) {
  const sock = makeSock();
  sock.user = user;
  bot.setSock(sock);
  return sock;
}

test("reply ke pesan bot terdeteksi walau participant kutipan memakai LID", () => {
  setBotUser({ id: `${OWNER}@s.whatsapp.net`, lid: "111222333444555@lid" });

  const contextInfo = {
    quotedMessage: { conversation: "Kamu makan apa hari ini?" },
    participant: "111222333444555@lid",
  };
  assert.equal(bot.isReplyToBot(contextInfo), true, "LID bot harus cocok");

  const contextInfoPn = {
    quotedMessage: { conversation: "Kamu makan apa hari ini?" },
    participant: `${OWNER}@s.whatsapp.net:12`,
  };
  assert.equal(bot.isReplyToBot(contextInfoPn), true, "PN bot harus cocok");

  assert.equal(bot.isReplyToBot({ quotedMessage: { conversation: "x" }, participant: "999888777@lid" }), false);
  assert.equal(bot.isReplyToBot({ participant: "111222333444555@lid" }), false, "tanpa quotedMessage bukan reply ke bot");
  assert.equal(bot.isReplyToBot({ quotedMessage: { conversation: "x" } }), false);
});

test("mention @bot terdeteksi dari LID bot", async () => {
  const agent = require("../ai/group-agent");
  const sock = setBotUser({ id: `${OWNER}@s.whatsapp.net`, lid: "111222333444555@lid" });
  reset(OWNER, [GROUP]);
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.AI_DEBOUNCE_MS = "60000";

  const m = msg({ text: "halo" });
  m.message = {
    extendedTextMessage: {
      text: "halo",
      contextInfo: { mentionedJid: ["111222333444555@lid"] },
    },
  };
  const pending = bot.handleMessage(m);
  await new Promise((resolve) => setImmediate(resolve));

  const entry = agent.getHistory(GROUP).at(-1);
  assert.equal(entry.mentioned_bot, true, "LID bot di mentionedJid harus dihitung sebagai mention");
  assert.equal(sock.sent.length, 0, "belum ada balasan sebelum debounce selesai");

  agent.clearConversation(GROUP); // batalkan pending, jangan panggil API nyata
  await pending;
  assert.equal(sock.sent.length, 0, "tidak boleh ada balasan dari sesi test");

  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("tag bot ditampilkan sebagai @NamaBot, bukan nomor PN/LID", async () => {
  const agent = require("../ai/group-agent");
  const sock = setBotUser({ id: `${OWNER}@s.whatsapp.net`, lid: "111222333444555@lid" });
  reset(OWNER, [GROUP]);
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.AI_DEBOUNCE_MS = "60000";
  const botName = agent.config().botName;

  const m = msg({ text: `@${OWNER} coba tebak` });
  m.message = {
    extendedTextMessage: {
      text: `@${OWNER} coba tebak`,
      contextInfo: { mentionedJid: ["111222333444555@lid"] },
    },
  };
  const pending = bot.handleMessage(m);
  await new Promise((resolve) => setImmediate(resolve));

  const entry = agent.getHistory(GROUP).at(-1);
  assert.equal(entry.text, `@${botName} coba tebak`, "nomor tag bot harus menjadi nama bot dengan @");
  assert.ok(!entry.text.includes(OWNER), "nomor PN bot tidak boleh tersisa di teks");

  agent.clearConversation(GROUP);
  await pending;
  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("gambar dengan caption diproses AI memakai teks caption", async () => {
  const agent = require("../ai/group-agent");
  setBotUser({ id: `${OWNER}@s.whatsapp.net` });
  reset(OWNER, [GROUP]);
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.AI_DEBOUNCE_MS = "60000";

  const m = {
    key: { remoteJid: GROUP, fromMe: false, participant: `${PLAYER}@s.whatsapp.net` },
    pushName: "Tester",
    message: { imageMessage: { caption: "lihat nih" } },
  };
  const pending = bot.handleMessage(m);
  await new Promise((resolve) => setImmediate(resolve));

  const entry = agent.getHistory(GROUP).at(-1);
  assert.equal(entry.text, "lihat nih", "caption harus dipakai sebagai teks pesan AI");
  assert.equal(entry.has_image, false, "tanpa url media, gambar tidak ikut (null)");

  agent.clearConversation(GROUP); // batalkan pending, jangan panggil API nyata
  await pending;
  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("foto sekali lihat (viewOnce) dengan caption tetap diproses AI", async () => {
  const agent = require("../ai/group-agent");
  setBotUser({ id: `${OWNER}@s.whatsapp.net` });
  reset(OWNER, [GROUP]);
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.AI_DEBOUNCE_MS = "60000";

  const m = {
    key: { remoteJid: GROUP, fromMe: false, participant: `${PLAYER}@s.whatsapp.net` },
    pushName: "Tester",
    message: { viewOnceMessageV2: { message: { imageMessage: { caption: "ini rahasia" } } } },
  };
  const pending = bot.handleMessage(m);
  await new Promise((resolve) => setImmediate(resolve));

  const entry = agent.getHistory(GROUP).at(-1);
  assert.equal(entry.text, "ini rahasia", "caption di dalam viewOnce harus terbaca");

  agent.clearConversation(GROUP);
  await pending;
  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("identitas bot menangani user.id yang hilang atau LID yang tidak ada", () => {
  setBotUser({ id: `${OWNER}@s.whatsapp.net` });
  assert.deepEqual(bot.botIdentities(), [OWNER]);
  setBotUser({ lid: "111222333444555@lid" });
  assert.deepEqual(bot.botIdentities(), ["111222333444555"]);
  setBotUser({});
  assert.deepEqual(bot.botIdentities(), []);
});

test("pembungkus viewOnce dibuka untuk deteksi media", () => {
  const wrapped = {
    viewOnceMessageV2: { message: { imageMessage: { caption: "cek ini", directPath: "/v2/media" } } },
  };
  const inner = bot.unwrapMediaWrappers(wrapped);
  assert.equal(inner.imageMessage.caption, "cek ini");
  assert.equal(bot.unwrapMediaWrappers({ conversation: "biasa" }).conversation, "biasa");
  assert.equal(bot.unwrapMediaWrappers(undefined), undefined);
  // tidak boleh loop tanpa henti pada wrapper rusak
  const broken = {};
  broken.viewOnceMessage = { message: broken };
  assert.equal(bot.unwrapMediaWrappers(broken), broken);
});

test("stream media dihentikan segera saat melewati batas", async () => {
  async function* chunks() {
    yield Buffer.alloc(4, 1);
    yield Buffer.alloc(4, 2);
  }

  await assert.rejects(
    bot.collectMediaStream(chunks(), { maxBytes: 6 }),
    (error) => error.code === "AI_MEDIA_TOO_LARGE",
  );
  assert.equal(bot.mediaFileLength({ fileLength: { toNumber: () => 1234 } }), 1234);
  assert.equal(bot.mediaFileLength({ fileLength: "invalid" }), null);
});

test("gambar, GIF, dan sticker diklasifikasikan untuk Jev", () => {
  assert.deepEqual(bot.classifyAiMedia({ type: "image", msg: {} }), { kind: "attachment", format: "image" });
  assert.deepEqual(bot.classifyAiMedia({ type: "video", msg: { gifPlayback: true } }), { kind: "sticker", format: "gif" });
  assert.deepEqual(
    bot.classifyAiMedia({ type: "image", kind: "sticker", format: "webp", msg: {} }),
    { kind: "sticker", format: "webp" },
  );
});

test("/clear, /memory, dan /reset mengelola konteks grup", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);

  await bot.handleMessage(msg({ text: "/memory" }));
  assert.match(last(sock).text, /Hanya owner/);

  await bot.handleMessage(msg({ from: OWNER, text: "/clear" }));
  assert.match(last(sock).text, /Percakapan aktif/);

  await bot.handleMessage(msg({ from: OWNER, text: "/memory" }));
  assert.match(last(sock).text, /MEMORI GRAD/);

  await bot.handleMessage(msg({ from: OWNER, text: "/reset" }));
  assert.match(last(sock).text, /seluruh memori/);
});

test("admin grup dapat mengelola konteks tanpa menjadi owner", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock({
    participants: [{ id: `${PLAYER}@s.whatsapp.net`, admin: "admin" }],
  });
  bot.setSock(sock);

  await bot.handleMessage(msg({ text: "/clear" }));
  assert.match(last(sock).text, /Percakapan aktif/);

  await bot.handleMessage(msg({ text: "/memory" }));
  assert.match(last(sock).text, /MEMORI GRAD/);
});

test("admin grup mode LID dikenali lewat alias metadata", async () => {
  reset(OWNER, [GROUP]);
  const lid = "987654321012345";
  const sock = makeSock({
    participants: [{ id: `${lid}@lid`, jid: `${PLAYER}@s.whatsapp.net`, admin: "admin" }],
  });
  bot.setSock(sock);

  await bot.handleMessage(msg({
    text: "/clear",
    participant: `${lid}@lid`,
    participantAlt: `${PLAYER}@s.whatsapp.net`,
  }));
  assert.match(last(sock).text, /Percakapan aktif/);
});

test("pesan biasa mode LID memakai nomor jid sebagai identitas", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  const lid = "777654321012345";
  try {
    reset(OWNER, [GROUP]);
    const sock = makeSock({
      participants: [{ id: `${lid}@lid`, jid: `${PLAYER}@s.whatsapp.net`, admin: null }],
    });
    bot.setSock(sock);

    await bot.handleMessage(msg({ from: OWNER, text: "/start" }));
    for (let i = 0; i < 3; i++) {
      await bot.handleMessage(msg({ text: "pong", participant: `${lid}@lid` }));
    }

    assert.ok(bot.games.get(GROUP).scores[PLAYER], "skor harus disimpan memakai nomor jid, bukan LID");
    assert.equal(bot.games.get(GROUP).scores[lid], undefined);
  } finally {
    Math.random = originalRandom;
  }
});

test("LID tanpa pasangan jid tidak pernah masuk whitelist DM", async () => {
  const agent = require("../ai/group-agent");
  const lid = "999654321012345";
  reset(OWNER, [GROUP]);
  bot.memoryStore.resetAllMemory();
  const sock = makeSock({ participants: [] });
  bot.setSock(sock);
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.AI_DEBOUNCE_MS = "60000";

  const pending = bot.handleMessage(msg({ text: "halo semuanya", participant: `${lid}@lid` }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.memoryStore.canDirectMessage(lid), false);
  assert.equal(agent.getHistory(GROUP).at(-1).sender_id, "nomor-tidak-diketahui");

  agent.clearConversation(GROUP);
  await pending;
  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("owner format 08 cocok dengan pengirim format 62", async () => {
  const localOwner = `0${OWNER.slice(2)}`;
  reset(localOwner, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);

  await bot.handleMessage(msg({ from: OWNER, text: "/memory" }));
  assert.match(last(sock).text, /MEMORI GRAD/);
});

test("owner dapat memberi, melihat, dan mencabut akses veto per grup", async () => {
  reset(OWNER, [GROUP]);
  const sock = makeSock();
  bot.setSock(sock);

  await bot.handleMessage(msg({ from: OWNER, text: `/veto ${PLAYER}` }));
  assert.match(last(sock).text, /sudah diberikan/);
  assert.deepEqual(bot.getData().vetoAccess[GROUP], [PLAYER]);

  await bot.handleMessage(msg({ text: "/memory" }));
  assert.match(last(sock).text, /MEMORI GRAD/);

  await bot.handleMessage(msg({ from: OWNER, text: "/veto list" }));
  assert.match(last(sock).text, new RegExp(PLAYER));

  await bot.handleMessage(msg({ from: OWNER, text: `/unveto ${PLAYER}` }));
  assert.match(last(sock).text, /sudah dicabut/);

  await bot.handleMessage(msg({ text: "/clear" }));
  assert.match(last(sock).text, /owner, admin grup, atau anggota/);
});

test("veto dari reply LID disimpan sebagai nomor PN peserta", async () => {
  reset(OWNER, [GROUP]);
  const lid = "123456789012345";
  const sock = makeSock({
    participants: [{ id: `${lid}@lid`, jid: `${PLAYER}@s.whatsapp.net`, admin: null }],
  });
  bot.setSock(sock);

  await bot.handleMessage(msg({
    from: OWNER,
    text: "/veto",
    contextInfo: {
      participant: `${lid}@lid`,
      quotedMessage: { conversation: "beri aku akses" },
    },
  }));

  assert.deepEqual(bot.getData().vetoAccess[GROUP], [PLAYER]);
});
