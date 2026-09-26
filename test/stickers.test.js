const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-stickers-");
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.OPENROUTER_API_KEY = "";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createStickerCollector, getStickerCollector, resetStickerCollector, stickerSha, redactContextLine } = require("../ai/stickers/collector");
const bot = require("../index.js");

const GROUP = "120363000000000@g.us";
const OTHER_GROUP = "120363999999999@g.us";
const OWNER = "628111111111";
const PLAYER = "628222222222";
const STRANGER = "628999999999";

const sha = (n) => Buffer.alloc(32, n);

test.after(async () => {
  await resetStickerCollector();
  cleanup();
});

function collector(name) {
  return createStickerCollector({ dir: path.join(testDir, name) });
}

test("stickerSha menerima Buffer, Uint8Array, JSON Buffer, dan base64", () => {
  const hex = sha(7).toString("hex");
  assert.equal(stickerSha(sha(7)), hex);
  assert.equal(stickerSha(new Uint8Array(sha(7))), hex);
  assert.equal(stickerSha(JSON.parse(JSON.stringify(sha(7)))), hex);
  assert.equal(stickerSha(sha(7).toString("base64")), hex);
  assert.equal(stickerSha(null), null);
  assert.equal(stickerSha(Buffer.alloc(4)), null);
});

test("konteks stiker diredaksi dan dibatasi panjangnya", () => {
  const line = redactContextLine("hubungi 0812-3456-7890 atau a@b.com pakai sk-or-v1-abcdefghijklmnopqrstuvwxyz " + "x".repeat(300));
  assert.doesNotMatch(line, /3456|a@b\.com|abcdefghijklmnop/);
  assert.match(line, /\[nomor\]/);
  assert.ok(line.length <= 160);
});

test("stiker yang sama dihitung ulang tanpa unduh ulang, dengan konteks sebelum/sesudah", async () => {
  const c = collector("dedupe");
  let downloads = 0;
  const download = async () => { downloads += 1; return Buffer.from("RIFFxxxxWEBP"); };
  const sticker = { fileSha256: sha(1), mimetype: "image/webp" };

  await c.observe({ chatId: GROUP, senderId: PLAYER, senderName: "Budi", text: "wkwk si rehan jatuh" });
  await c.observe({ chatId: GROUP, senderId: PLAYER, senderName: "Budi", sticker, download, at: 1_000 });
  await c.observe({ chatId: GROUP, senderId: OWNER, senderName: "Rehan", text: "anjir malu" });
  await c.observe({ chatId: GROUP, senderId: OWNER, senderName: "Rehan", text: "udah ah" });
  await c.observe({ chatId: GROUP, senderId: OWNER, senderName: "Rehan", text: "baris ketiga tidak ikut" });
  await c.observe({ chatId: OTHER_GROUP, senderId: OWNER, senderName: "Rehan", sticker, download, at: 2_000 });

  assert.equal(downloads, 1, "file hanya diunduh sekali");
  const file = path.join(c.dir, "candidates", `${sha(1).toString("hex")}.webp`);
  assert.ok(fs.existsSync(file));

  const stats = await c.stats({ at: 3_000 });
  assert.equal(stats.candidates, 1);
  assert.equal(stats.stored, 1);
  assert.equal(stats.uses, 2);
  assert.deepEqual([stats.top[0].useCount, stats.top[0].chats, stats.top[0].senders], [2, 2, 2]);

  const contexts = await c.contexts(sha(1).toString("hex"));
  assert.equal(contexts[0].before, "Budi: wkwk si rehan jatuh");
  assert.equal(contexts[0].after, "Rehan: anjir malu\nRehan: udah ah");
  assert.equal(contexts[1].chatId, OTHER_GROUP);
  assert.equal(contexts[1].before, "", "konteks tidak bocor antar chat");
  await c.close();
});

test("cuplikan konteks per stiker maksimal 5, yang terlama dibuang", async () => {
  const c = collector("contexts");
  for (let i = 0; i < 7; i += 1) {
    await c.observe({ chatId: GROUP, senderName: "Budi", text: `pesan ${i}` });
    await c.observe({ chatId: GROUP, senderName: "Budi", sticker: { fileSha256: sha(2) }, at: 1_000 + i });
  }
  const contexts = await c.contexts(sha(2).toString("hex"));
  assert.equal(contexts.length, 5);
  assert.match(contexts[0].before, /pesan 2/);
  assert.equal((await c.stats()).top[0].useCount, 7);
  await c.close();
});

test("unduhan gagal tidak menghapus kandidat dan dicoba lagi pada kemunculan berikutnya", async () => {
  const c = collector("retry");
  let calls = 0;
  const download = async () => { calls += 1; if (calls === 1) throw new Error("media expired"); return Buffer.from("webp"); };
  await c.observe({ chatId: GROUP, sticker: { fileSha256: sha(3) }, download });
  assert.equal((await c.stats()).stored, 0);
  await c.observe({ chatId: GROUP, sticker: { fileSha256: sha(3) }, download });
  const stats = await c.stats();
  assert.deepEqual([stats.candidates, stats.stored, stats.uses], [1, 1, 2]);
  await c.close();
});

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `s${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({ subject: "Grup Test", participants: [] }),
  };
}

function stickerMsg({ chat = GROUP, from = PLAYER, n = 9 } = {}) {
  return {
    key: { id: `st-${Math.random()}`, remoteJid: chat, fromMe: false, participant: chat.endsWith("@g.us") ? `${from}@s.whatsapp.net` : undefined },
    pushName: "Budi",
    message: { stickerMessage: { fileSha256: sha(n), mimetype: "image/webp" } },
  };
}

function textMsg({ chat = GROUP, from = PLAYER, text }) {
  return {
    key: { id: `t-${Math.random()}`, remoteJid: chat, fromMe: false, participant: chat.endsWith("@g.us") ? `${from}@s.whatsapp.net` : undefined },
    pushName: from === OWNER ? "Rehan" : "Budi",
    message: { conversation: text },
  };
}

test("stiker di grup yang diizinkan dan DM whitelist tercatat; grup lain dan orang asing tidak", async () => {
  await resetStickerCollector();
  bot.resetData();
  bot.getData().owner = OWNER;
  bot.getData().allowedGroups = [GROUP];
  bot.memoryStore.resetAllMemory();
  bot.memoryStore.recordParticipant({ phone: PLAYER, name: "Budi", groupId: GROUP, at: "2026-09-26 10:00 WIT" });
  const sock = makeSock();
  bot.setSock(sock);

  await bot.dispatchInboundMessage(stickerMsg({ n: 9 }), { sock });
  await bot.dispatchInboundMessage(stickerMsg({ n: 9 }), { sock });
  await bot.dispatchInboundMessage(stickerMsg({ chat: `${PLAYER}@s.whatsapp.net`, n: 10 }), { sock });
  await bot.dispatchInboundMessage(stickerMsg({ chat: OTHER_GROUP, n: 11 }), { sock });
  await bot.dispatchInboundMessage(stickerMsg({ chat: `${STRANGER}@s.whatsapp.net`, from: STRANGER, n: 12 }), { sock });
  await getStickerCollector().flush();

  const stats = await getStickerCollector().stats();
  assert.equal(stats.candidates, 2, "hanya stiker dari grup diizinkan + DM whitelist");
  assert.equal(stats.uses, 3);
  const dmContexts = await getStickerCollector().contexts(sha(10).toString("hex"));
  assert.equal(dmContexts[0].isDm, true, "konteks DM ditandai agar tidak masuk prompt grup");
});

test("/stiker menampilkan kandidat untuk owner dan menolak non-owner; /s tetap command pembuat stiker", async () => {
  const sock = makeSock();
  bot.setSock(sock);
  await bot.dispatchInboundMessage(textMsg({ from: PLAYER, text: "/stiker" }), { sock });
  assert.match(sock.sent.at(-1).text, /Hanya owner/);

  await bot.dispatchInboundMessage(textMsg({ from: OWNER, text: "/stiker" }), { sock });
  const status = sock.sent.at(-1).text;
  assert.match(status, /KOLEKSI STIKER GRAD/);
  assert.match(status, /kandidat menunggu: 2/);
  assert.match(status, new RegExp(sha(9).toString("hex").slice(0, 8)));

  await bot.dispatchInboundMessage(textMsg({ from: OWNER, text: "/s" }), { sock });
  assert.match(sock.sent.at(-1).text, /untuk membuat stiker/);
});
