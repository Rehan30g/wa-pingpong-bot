process.env.BOT_DATA_FILE = "./test/data.json";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const bot = require("../index.js");

const GROUP = "120363000000000@g.us";
const OWNER = "628111111111";
const PLAYER = "628222222222";

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => {
      sent.push({ jid, text: content.text });
      return { key: { id: "x" } };
    },
    groupMetadata: async (jid) => ({ subject: "Grup Test" }),
  };
}

function msg({ chat = GROUP, from = PLAYER, text, pushName = "Tester" }) {
  return {
    key: {
      remoteJid: chat,
      fromMe: false,
      participant: chat.endsWith("@g.us") ? `${from}@s.whatsapp.net` : undefined,
    },
    pushName,
    message: { conversation: text },
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
  assert.ok(JSON.parse(fs.readFileSync("./test/data.json", "utf8")).owner === PLAYER, "owner tersimpan di file");
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
  assert.ok(JSON.parse(fs.readFileSync("./test/data.json", "utf8")).allowedGroups.includes(GROUP));
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
});
