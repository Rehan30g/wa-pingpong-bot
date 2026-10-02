const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-features-");
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_DM_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const features = require("../ai/features");
const tools = require("../ai/agent/tools");
const bot = require("../index.js");
const groupAgent = require("../ai/group-agent");
const { getStickerCollector, resetStickerCollector } = require("../ai/stickers/collector");

test.after(async () => {
  await resetStickerCollector();
  cleanup();
});

const GROUP = "120363444444444@g.us";
const GROUP2 = "120363555555555@g.us";
const OWNER = "628111111111";
const ADMIN = "628333333333";
const MEMBER = "628444444444";
const STRANGER = "628999999999";

function freshFeatures() {
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
}

// ---------- modul fitur ----------

test("default, kunci global owner, setelan per grup, DM ikut global, dan log perubahan", () => {
  freshFeatures();
  assert.equal(features.isEnabled(GROUP, "web"), true);
  assert.equal(features.isEnabled(GROUP, "python"), true, "python aktif default");
  assert.deepEqual(features.availableFeatures(), ["web", "audio", "stiker", "media", "reminder", "memori", "latar", "edit_media", "sosial", "dokumen", "python", "skill"]);

  assert.equal(features.setGroupFeature(GROUP, "stiker", false, { phone: ADMIN, role: "admin" }).ok, true);
  assert.equal(features.isEnabled(GROUP, "stiker"), false);
  assert.equal(features.isEnabled(GROUP2, "stiker"), true, "grup lain tidak terpengaruh");

  features.setGlobalLock("web", true, { phone: OWNER, role: "owner" });
  assert.equal(features.isEnabled(GROUP, "web"), false);
  assert.equal(features.isEnabled(`${MEMBER}@s.whatsapp.net`, "web"), false, "kunci global juga berlaku di DM");
  assert.equal(features.setGroupFeature(GROUP, "web", true, { phone: ADMIN, role: "admin" }).error, "dikunci_owner");
  assert.equal(features.setGroupFeature(GROUP, "web", false, { phone: ADMIN }).ok, true, "mematikan tetap boleh walau dikunci");
  features.setGlobalLock("web", false, { phone: OWNER, role: "owner" });
  assert.equal(features.isEnabled(GROUP, "web"), false, "setelan grup yang mematikan tetap berlaku setelah kunci dibuka");
  assert.equal(features.isEnabled(GROUP2, "web"), true);

  features.resetCache();
  assert.equal(features.isEnabled(GROUP, "stiker"), false, "tersimpan di file");
  const log = features.recentLog(10);
  assert.equal(log[0].feature, "web");
  assert.ok(log.some((entry) => entry.scope === GROUP && entry.feature === "stiker" && entry.from === true && entry.to === false && entry.by === ADMIN));
});

test("/menu mengikuti fitur aktif grup dan menyembunyikan bagian owner dari non-owner", async () => {
  freshFeatures();
  const menu = require("../commands/menu");
  const render = async (fromOwner) => {
    let text = "";
    await menu.handler({ sock: { sendMessage: async (_jid, content) => { text = content.text; } }, jid: GROUP, fromOwner });
    return text;
  };
  const member = await render(false);
  assert.match(member, /cari info terbaru/);
  assert.match(member, /hitung, grafik, QR/, "python aktif default");
  assert.match(member, /Python\* — hitung, grafik, QR .*kurs, cuaca, jadwal sholat, patungan/, "skill tampil di baris fiturnya");
  assert.doesNotMatch(member, /skill siap pakai/);
  assert.doesNotMatch(member, /\/agent social/);
  features.setGroupFeature(GROUP, "web", false, { role: "admin" });
  features.setGlobalLock("python", true, { role: "owner" });
  const owner = await render(true);
  assert.doesNotMatch(owner, /cari info terbaru/);
  assert.doesNotMatch(owner, /hitung, grafik, QR/, "python dikunci owner → tidak ditawarkan");
  assert.match(owner, /\/agent social on\|off/);
  features.setGlobalLock("python", false, { role: "owner" });
});

test("tools fitur yang mati tidak pernah dikirim ke GLM", () => {
  const ctx = { hasAudio: true, hasMedia: true, mediaPart: () => ({}), stickers: { usable: new Map([["x", {}]]), queue: [] } };
  const all = tools.toolDefinitions(ctx).map((t) => t.function?.name || t.type);
  // stay_silent tidak terikat fitur: menolak menjawab selalu boleh.
  assert.deepEqual(all.sort(), ["get_chat_media", "listen_audio", "openrouter:web_search", "send_sticker", "stay_silent", "web_fetch"].sort());
  const limited = tools.toolDefinitions({ ...ctx, features: new Set(["audio"]) }).map((t) => t.function?.name || t.type);
  assert.deepEqual(limited.sort(), ["listen_audio", "stay_silent"]);
});

// ---------- penegakan di alur pesan ----------

function makeSock(participants = []) {
  const sent = [];
  const sock = {
    sent,
    participants,
    sendMessage: async (jid, content, options) => { sent.push({ jid, ...content, options }); return { key: { id: `bot-${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
    groupMetadata: async (jid) => ({ id: jid, subject: jid === GROUP ? "Grup Tester" : "Grup Dua", participants: sock.participants }),
  };
  return sock;
}

const member = (phone, admin = null) => ({ id: `${phone}@s.whatsapp.net`, jid: `${phone}@s.whatsapp.net`, admin });

let counter = 0;
function msg({ chat = GROUP, from = MEMBER, text = "", message = null }) {
  return {
    key: { id: `f${++counter}`, remoteJid: chat, fromMe: false, participant: chat.endsWith("@g.us") ? `${from}@s.whatsapp.net` : undefined },
    pushName: from === ADMIN ? "Admin" : "Budi",
    message: message || { conversation: text },
  };
}

function setupBot(sock) {
  bot.resetData();
  bot.getData().owner = OWNER;
  bot.getData().allowedGroups = [GROUP, GROUP2];
  bot.setSock(sock);
  bot.memoryStore.resetAllMemory();
  groupAgent.resetHistories();
}

test("web mati di grup: GLM tidak mendapat web_search/web_fetch dan tahu fiturnya dimatikan", async () => {
  freshFeatures();
  features.setGroupFeature(GROUP, "web", false, { role: "admin" });
  const mock = await createMockOpenRouter({ chat: ["Aku nggak bisa cek internet di grup ini."] }).start();
  try {
    const sock = makeSock();
    await groupAgent.processGroupMessage({ sock, message: { key: { id: "w1", remoteJid: GROUP } }, groupId: GROUP, senderId: MEMBER, senderName: "Budi", text: "@Grad harga emas?", explicitMention: true, replyToBot: false, quotedText: "" });
    const request = mock.state.chat[0];
    assert.ok(!(request.tools || []).some((t) => t.type === "openrouter:web_search" || t.function?.name === "web_fetch"));
    assert.match(request.messages[0].content, /web dimatikan admin/);
  } finally {
    await mock.stop();
  }
});

test("media mati: gambar tidak dikirim ke GLM", async () => {
  freshFeatures();
  features.setGroupFeature(GROUP, "media", false, { role: "admin" });
  const mock = await createMockOpenRouter({ chat: ["oke"] }).start();
  try {
    groupAgent.resetHistories();
    await groupAgent.processGroupMessage({ sock: makeSock(), message: { key: { id: "i1", remoteJid: GROUP } }, groupId: GROUP, senderId: MEMBER, senderName: "Budi", text: "@Grad ini apa?", explicitMention: true, replyToBot: false, quotedText: "", media: { type: "image", dataUrl: "data:image/jpeg;base64,QUJD" } });
    assert.doesNotMatch(JSON.stringify(mock.state.chat[0].messages), /image_url/);
  } finally {
    await mock.stop();
  }
});

test("stiker mati: stiker tidak dikumpulkan dan tidak dipakai", async () => {
  freshFeatures();
  await resetStickerCollector();
  features.setGroupFeature(GROUP, "stiker", false, { role: "admin" });
  const sock = makeSock();
  setupBot(sock);
  bot.memoryStore.recordParticipant({ phone: MEMBER, name: "Budi", groupId: GROUP, at: "2026-09-26 10:00 WIT" });
  const sticker = { stickerMessage: { fileSha256: Buffer.alloc(32, 9), mimetype: "image/webp" } };
  await bot.dispatchInboundMessage(msg({ chat: GROUP, message: sticker }), { sock });
  await bot.dispatchInboundMessage(msg({ chat: GROUP2, message: sticker }), { sock });
  await getStickerCollector().flush();
  const stats = await getStickerCollector().stats();
  assert.equal(stats.uses, 1, "hanya grup dengan fitur stiker aktif yang dikumpulkan");
});

test("audio mati: voice note tidak dikirim ke model audio, cukup penanda di riwayat", async () => {
  freshFeatures();
  features.setGroupFeature(GROUP, "audio", false, { role: "admin" });
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.99 } }).start();
  try {
    const sock = makeSock();
    setupBot(sock);
    const vn = { audioMessage: { seconds: 5, ptt: true, mimetype: "audio/ogg; codecs=opus" } };
    await bot.dispatchInboundMessage(msg({ chat: GROUP, message: vn }), { sock });
    await bot.dispatchInboundMessage(msg({ chat: GROUP2, message: vn }), { sock });
    assert.equal(mock.state.audio.length, 0);
    assert.equal(groupAgent.getHistory(GROUP).at(-1).text, "[voice note 0:05]");
    assert.equal(groupAgent.getHistory(GROUP2).at(-1).text, "[voice note 0:05, belum bisa didengar]", "grup lain tetap mencoba mendengar");
  } finally {
    await mock.stop();
  }
});

// ---------- command ----------

test("/grup dan /fitur lewat DM: admin mengatur grupnya, non-admin tidak, orang asing tidak dibalas", async () => {
  freshFeatures();
  const sock = makeSock([member(ADMIN, "admin"), member(MEMBER)]);
  setupBot(sock);
  bot.memoryStore.recordParticipant({ phone: MEMBER, name: "Budi", groupId: GROUP, at: "2026-09-26 10:00 WIT" });
  const dm = (from, text) => bot.dispatchInboundMessage(msg({ chat: `${from}@s.whatsapp.net`, from, text }), { sock });

  await dm(ADMIN, "/grup");
  assert.match(sock.sent.at(-1).text, /1\. Grup Tester \(12\/12 fitur aktif\)/);
  await dm(ADMIN, "/fitur 1");
  assert.match(sock.sent.at(-1).text, /✅ \*stiker\*/);
  await dm(ADMIN, "/fitur 1 stiker off");
  assert.match(sock.sent.at(-1).text, /Fitur \*stiker\* di \*Grup Tester\* sekarang mati/);
  assert.equal(features.isEnabled(GROUP, "stiker"), false);
  assert.equal(sock.sent.at(-1).jid, `${ADMIN}@s.whatsapp.net`, "tidak ada pengumuman ke grup");
  assert.ok(!sock.sent.some((s) => s.jid === GROUP), "senyap");

  await dm(MEMBER, "/fitur 1 stiker on");
  assert.match(sock.sent.at(-1).text, /Nomor grup tidak dikenal/, "anggota biasa tidak melihat grup untuk diatur");
  assert.equal(features.isEnabled(GROUP, "stiker"), false);

  const before = sock.sent.length;
  await dm(STRANGER, "/grup");
  assert.equal(sock.sent.length, before, "orang asing tidak dibalas");

  await dm(OWNER, "/fitur global web kunci");
  assert.match(sock.sent.at(-1).text, /dikunci di semua grup/);
  await dm(ADMIN, "/fitur 1 web on");
  assert.match(sock.sent.at(-1).text, /dikunci owner/);
  await dm(ADMIN, "/fitur global web buka");
  assert.match(sock.sent.at(-1).text, /hanya untuk owner/);

  sock.participants = [member(ADMIN), member(MEMBER)]; // admin dicabut
  const beforeDemoted = sock.sent.length;
  await dm(ADMIN, "/fitur 1 stiker on");
  assert.equal(sock.sent.length, beforeDemoted, "bekas admin yang tidak di whitelist diperlakukan seperti orang asing");
  assert.equal(features.isEnabled(GROUP, "stiker"), false);
});

test("/fitur di grup hanya menampilkan status (read-only) untuk siapa pun", async () => {
  freshFeatures();
  features.setGroupFeature(GROUP, "audio", false, { role: "admin" });
  const sock = makeSock([member(MEMBER)]);
  setupBot(sock);
  await bot.dispatchInboundMessage(msg({ chat: GROUP, from: MEMBER, text: "/fitur" }), { sock });
  const text = sock.sent.at(-1).text;
  assert.match(text, /Fitur Grad di grup ini/);
  assert.match(text, /❌ \*audio\*/);
  assert.match(text, /✅ \*web\*/);
  await bot.dispatchInboundMessage(msg({ chat: GROUP, from: MEMBER, text: "/fitur 1 audio on" }), { sock });
  assert.match(sock.sent.at(-1).text, /lewat chat pribadi/);
  assert.equal(features.isEnabled(GROUP, "audio"), false);
});

test("stiker dimatikan: send_sticker tidak ditawarkan walau koleksi ada", async () => {
  freshFeatures();
  features.setGroupFeature(GROUP, "stiker", false, { role: "admin" });
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("send_sticker", { sticker_id: "abcdef12", placement: "only" })] }, "hehe"] }).start();
  try {
    await groupAgent.processGroupMessage({ sock: makeSock(), message: { key: { id: "s1", remoteJid: GROUP } }, groupId: GROUP, senderId: MEMBER, senderName: "Budi", text: "@Grad wkwk", explicitMention: true, replyToBot: false, quotedText: "" });
    assert.ok(!(mock.state.chat[0].tools || []).some((t) => t.function?.name === "send_sticker"));
    assert.match(JSON.parse(mock.state.chat[1].messages.at(-1).content).result.error, /tidak tersedia/);
  } finally {
    await mock.stop();
  }
});
