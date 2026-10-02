const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-motion-");
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const sharp = require("sharp");
const motion = require("../ai/media/motion");
const { getStickerCollector, resetStickerCollector } = require("../ai/stickers/collector");
const { getStickerLibrary } = require("../ai/stickers/library");
const curator = require("../ai/stickers/curator");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const memoryStore = require("../ai/memory-store");

const GROUP = "120363111111111@g.us";
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.after(async () => {
  await resetStickerCollector();
  cleanup();
});

async function animatedWebp(frames = 4, delay = 100) {
  const pngs = await Promise.all(Array.from({ length: frames }, (_, i) => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: i * 50, g: 20, b: 90, alpha: 1 } } }).png().toBuffer()));
  return sharp(pngs, { join: { animated: true } }).webp({ delay: Array(frames).fill(delay), loop: 0 }).toBuffer();
}

const staticWebp = () => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).webp().toBuffer();

function durationOf(buffer) {
  const file = path.join(testDir, `probe-${Date.now()}-${Math.random()}.mp4`);
  fs.writeFileSync(file, buffer);
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
}

function fakeHttp(summary = "kucing hijau membanting tangan, kesal") {
  const calls = [];
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      return { choices: [{ message: { content: JSON.stringify({ motion: "diam lalu membanting tangan", emotion: "kesal", text_in_media: "", summary }) } }], usage: { cost: 0.00025 } };
    },
  };
}

test("stiker animasi → mp4 diperlambat 4×; GIF mp4 ikut diperlambat", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  const webp = await animatedWebp(4, 100); // 0,4 dtk
  const mp4 = await motion.animatedWebpToSlowMp4(webp, { slowdown: 4 });
  assert.ok(Math.abs(durationOf(mp4) - 1.6) < 0.25, "0,4 dtk × 4");
  const slower = await motion.videoToSlowMp4(mp4, { slowdown: 2 });
  assert.ok(Math.abs(durationOf(slower) - 3.2) < 0.4);
});

test("describeMotion: Gemini menonton video lambat (reasoning off), stiker statis tidak dipanggil", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  motion._reset();
  const http = fakeHttp();
  const result = await motion.describeMotion({ buffer: await animatedWebp(), kind: "sticker", http });
  assert.equal(result.summary, "kucing hijau membanting tangan, kesal");
  assert.equal(result.emotion, "kesal");
  const { body } = http.calls[0];
  assert.equal(body.model, "google/gemini-3.1-flash-lite");
  assert.deepEqual(body.reasoning, { enabled: false });
  const video = body.messages[0].content.find((part) => part.type === "video_url");
  assert.match(video.video_url.url, /^data:video\/mp4;base64,/);
  assert.match(body.messages[0].content[0].text, /4× lebih lambat/);

  assert.equal(await motion.describeMotion({ buffer: await staticWebp(), http }), null);
  assert.equal(http.calls.length, 1, "stiker statis tidak dikirim ke model");
  assert.equal(await motion.describeMotion({ buffer: await animatedWebp() }), null, "tanpa key (tes) tidak ada panggilan jaringan");
});

test("describeMotion: kuota harian dan MOTION_ENABLED=false", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  motion._reset();
  const http = fakeHttp();
  const buffer = await animatedWebp();
  process.env.MOTION_DAILY_LIMIT = "1";
  try {
    assert.ok(await motion.describeMotion({ buffer, http }));
    assert.equal(await motion.describeMotion({ buffer, http }), null);
    assert.equal(http.calls.length, 1);
  } finally {
    delete process.env.MOTION_DAILY_LIMIT;
  }
  process.env.MOTION_ENABLED = "false";
  try {
    assert.equal(await motion.describeMotion({ buffer, http }), null);
  } finally {
    delete process.env.MOTION_ENABLED;
  }
});

test("motionFor: sekali per stiker, tersimpan di DB stiker dan dipakai ulang setelah restart", async () => {
  motion._reset();
  await resetStickerCollector();
  process.env.STICKER_DIR = path.join(testDir, "stickers-cache");
  const store = getStickerCollector();
  const buffer = await animatedWebp();
  let calls = 0;
  const describe = async () => { calls += 1; return { summary: "kuda menabrak tembok", motion: "berlari lalu menabrak", emotion: "konyol", text: "GOKIL", model: "m" }; };
  const [a, b] = await Promise.all([
    motion.motionFor({ key: "aa11", buffer, store, describe }),
    motion.motionFor({ key: "aa11", buffer, store, describe }),
  ]);
  assert.equal(a.summary, "kuda menabrak tembok");
  assert.equal(b.summary, "kuda menabrak tembok");
  assert.equal(calls, 1, "panggilan bersamaan digabung");
  motion._reset(); // cache memori hilang (restart)
  assert.equal((await motion.motionFor({ key: "aa11", buffer, store, describe })).text, "GOKIL");
  assert.equal(calls, 1, "dibaca dari DB, tidak memanggil model lagi");
  assert.equal(await motion.motionFor({ key: "bb22", buffer: await staticWebp(), store, describe }), null);
  assert.equal(calls, 1, "stiker statis dilewati");
});

test("teks riwayat stiker/GIF memakai deskripsi gerakan", () => {
  const m = { summary: "kucing hijau membanting tangan, kesal" };
  assert.equal(motion.motionHistoryText({ kind: "sticker", motion: m }), "[mengirim stiker animasi: gerakan: kucing hijau membanting tangan, kesal]");
  assert.equal(motion.motionHistoryText({ kind: "sticker", label: "kucing kesal", motion: m }), "[mengirim stiker animasi: kucing kesal · gerakan: kucing hijau membanting tangan, kesal]");
  assert.equal(motion.motionHistoryText({ kind: "gif", motion: m }), "[mengirim GIF: gerakan: kucing hijau membanting tangan, kesal]");
  assert.equal(motion.motionHistoryText({ kind: "sticker" }), "[mengirim stiker]");
});

test("index: addMediaMotion hanya menambah gerakan untuk stiker/GIF; buffer GIF tidak ikut tersimpan", async () => {
  const bot = require("../index");
  const original = motion.motionFor;
  const seen = [];
  motion.motionFor = async (args) => { seen.push(args); return { summary: "joget", motion: "", emotion: "", text: "" }; };
  try {
    const webp = await animatedWebp();
    const sha = Buffer.alloc(32, 7);
    const m = { message: { stickerMessage: { fileSha256: sha } } };
    const sticker = await bot.addMediaMotion({ type: "image", kind: "sticker", format: "webp", dataUrl: `data:image/webp;base64,${webp.toString("base64")}` }, m);
    assert.equal(sticker.motion.summary, "joget");
    assert.equal(seen[0].key, sha.toString("hex"));
    assert.equal(seen[0].kind, "sticker");
    assert.equal(await bot.stickerHistoryText(m, sticker), "[mengirim stiker animasi: gerakan: joget]");

    const gif = { type: "video", kind: "sticker", format: "gif", frameDataUrl: null };
    Object.defineProperty(gif, "motionSource", { value: { buffer: Buffer.from("mp4"), key: "cc" }, enumerable: false, configurable: true, writable: true });
    await bot.addMediaMotion(gif, { message: {} });
    assert.equal(seen[1].kind, "gif");
    assert.equal(gif.motionSource, undefined, "buffer GIF dibuang setelah ditonton");
    assert.equal(bot.videoHistoryText(gif), "[mengirim GIF: gerakan: joget]");

    const photo = await bot.addMediaMotion({ type: "image", kind: "attachment", format: "image", dataUrl: "data:image/jpeg;base64,AAAA" }, { message: {} });
    assert.equal(photo.motion, undefined);
    assert.equal(seen.length, 2, "foto biasa tidak ditonton");
  } finally {
    motion.motionFor = original;
  }
});

test("GLM menerima deskripsi gerakan stiker yang di-reply dan hasil get_chat_media", async () => {
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("get_chat_media", { entry_id: 0 })] }, "Itu kucing lagi kesel."] }).start();
  groupAgent.resetHistories();
  memoryStore.resetAllMemory();
  const media = { type: "image", kind: "sticker", format: "webp", dataUrl: "data:image/webp;base64,UklGRg==", motion: { summary: "kucing hijau membanting tangan, kesal" } };
  groupAgent.setMediaLoader(async () => ({ ...media, motion: { summary: "kuda menabrak tembok" } }));
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    // Stiker lama tanpa media tersimpan (hanya jenisnya) → harus diambil lewat get_chat_media.
    groupAgent.remember(GROUP, { sender: "Budi", senderId: "628222", text: "[mengirim stiker]", media: { type: "image", kind: "sticker", format: "webp" }, messageKey: { id: "old" }, messageRef: { key: { id: "old" }, message: { stickerMessage: {} } } });
    const oldId = groupAgent.getHistory(GROUP).at(-1).entry_id;
    mock.script.chat[0].tool_calls[0].function.arguments = JSON.stringify({ entry_id: oldId });
    await groupAgent.processGroupMessage({
      sock, groupId: GROUP, senderId: "628333", senderName: "Ani", text: "@Grad ini stiker artinya apa", explicitMention: true, replyToBot: false, quotedText: "",
      message: { key: { id: "q1", remoteJid: GROUP }, message: { conversation: "x" } }, media,
    });
    const first = JSON.stringify(mock.state.chat[0].messages);
    assert.match(first, /Gerakan animasinya \(ditonton sebagai video; gambar hanya satu frame\): kucing hijau membanting tangan, kesal/);
    const second = mock.state.chat[1].messages;
    const toolResult = JSON.parse(second.find((m) => m.role === "tool").content).result;
    assert.equal(toolResult.motion, "kuda menabrak tembok");
    assert.match(JSON.stringify(second.at(-1).content), /gerakan animasinya: kuda menabrak tembok/);
    assert.equal(sent.at(-1).text, "Itu kucing lagi kesel.");
  } finally {
    groupAgent.setMediaLoader(null);
    groupAgent.resetHistories();
    await mock.stop();
  }
});

test("kurasi: stiker animasi dinilai dengan deskripsi gerakan, stiker statis tidak ditonton", async () => {
  await resetStickerCollector();
  process.env.STICKER_DIR = path.join(testDir, "stickers-curation");
  const collector = getStickerCollector();
  const library = getStickerLibrary();
  const moving = await animatedWebp();
  const still = await staticWebp();
  for (const [n, buffer] of [[1, moving], [2, still]]) {
    await collector.observe({ chatId: GROUP, senderId: "6282", senderName: "Budi", sticker: { fileSha256: Buffer.alloc(32, n) }, download: async () => buffer });
  }
  const watched = [];
  const requests = [];
  const glm = { chatCompletion: async (request) => { requests.push(request); return { text: JSON.stringify({ decisions: [], removals: [] }), cost: 0 }; } };
  await curator.runCuration({ glm, library, motion: async ({ key, kind }) => { watched.push([key.slice(0, 2), kind]); return { summary: "kucing membanting tangan", motion: "diam lalu membanting tangan ke meja", emotion: "kesal" }; } });
  assert.deepEqual(watched, [["01", "sticker"]]);
  const prompt = JSON.stringify(requests[0].messages);
  assert.match(prompt, /Gerakan \(hasil menonton animasinya sebagai video[^)]*\): diam lalu membanting tangan ke meja; emosi: kesal/);
});
