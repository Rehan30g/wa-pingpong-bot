const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-video-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const videoWatch = require("../ai/media/video-watch");
const groupAgent = require("../ai/group-agent");

test.after(() => cleanup());

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const GROUP = "120363444000111@g.us";

function sampleVideo(seconds = 3) {
  const file = path.join(testDir, `v${seconds}.mp4`);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=640x360:rate=25`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { windowsHide: true });
  return fs.readFileSync(file);
}

test("prepareVideo: diperkecil ≤480px, audio tetap ada, dipotong ke batas", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  const prepared = await videoWatch.prepareVideo(sampleVideo(4), { maxSec: 2 });
  assert.equal(prepared.truncated, true);
  const file = path.join(testDir, "prepared.mp4");
  fs.writeFileSync(file, prepared.mp4);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width", "-show_entries", "format=duration", "-of", "json", file]).stdout.toString();
  const info = JSON.parse(probe);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"), "audio tetap ada untuk transkrip");
  assert.equal(info.streams.find((s) => s.codec_type === "video").width, 480);
  assert.ok(Number(info.format.duration) <= 2.2);
});

test("watchVideo: video + pertanyaan dikirim ke model video (thinking off), jawaban teks kembali", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  const calls = [];
  const http = { post: async (url, body) => { calls.push(body); return { choices: [{ message: { content: "[musik] \"you made it all up\" (lirik lagu)" } }], usage: { cost: 0.0021 } }; } };
  const seen = await videoWatch.watchVideo({ buffer: sampleVideo(2), question: "transkrip semua ucapan dan lirik", http });
  assert.match(seen.answer, /you made it all up/);
  assert.equal(seen.cost, 0.0021);
  const body = calls[0];
  assert.equal(body.model, "google/gemini-3.1-flash-lite");
  assert.deepEqual(body.reasoning, { enabled: false });
  const parts = body.messages[1].content;
  assert.match(parts[0].text, /transkrip semua ucapan dan lirik/);
  assert.match(parts[1].video_url.url, /^data:video\/mp4;base64,/);
  await assert.rejects(videoWatch.watchVideo({ buffer: sampleVideo(1), question: "x" }), /model video tidak tersedia/, "tanpa key tidak memanggil jaringan");
});

test("'Transkrip video ini': GLM memanggil watch_video untuk pesan video itu, prompt tidak lagi bilang video belum didukung", async () => {
  const original = videoWatch.watchVideo;
  const watched = [];
  videoWatch.watchVideo = async (args) => { watched.push(args); return { answer: "Lirik: \"you made it all up\"", cost: 0.002 }; };
  groupAgent.setRawMediaLoader(async () => ({ buffer: Buffer.from("mp4"), kind: "video", ext: "mp4" }));
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("watch_video", { entry_id: 0, question: "transkrip semua ucapan dan lirik" })] }, "isinya lirik \"you made it all up\""] }).start();
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const run = groupAgent.processGroupMessage({
      sock, groupId: GROUP, senderId: "628111", senderName: "Rehan", text: "Transkrip video ini", explicitMention: true, replyToBot: false, quotedText: "",
      message: { key: { id: "v1", remoteJid: GROUP }, message: { videoMessage: { caption: "Transkrip video ini" } } },
      media: { type: "video", kind: "attachment", format: "video", frameDataUrl: null },
    });
    const entry = groupAgent.getHistory(GROUP).at(-1);
    mock.script.chat[0].tool_calls[0].function.arguments = JSON.stringify({ entry_id: entry.entry_id, question: "transkrip semua ucapan dan lirik" });
    const result = await run;
    assert.equal(result.action, "reply");
    const request = mock.state.chat[0];
    assert.ok(request.tools.some((t) => t.function?.name === "watch_video"));
    assert.ok(!JSON.stringify(request.messages).includes("belum didukung"));
    assert.match(JSON.stringify(request.messages), /pakai watch_video/);
    assert.equal(watched[0].question, "transkrip semua ucapan dan lirik");
    assert.match(JSON.parse(mock.state.chat[1].messages.at(-1).content).result.answer, /you made it all up/);
    assert.equal(sent.at(-1).text, "isinya lirik \"you made it all up\"");
  } finally {
    videoWatch.watchVideo = original;
    groupAgent.setRawMediaLoader(null);
    await mock.stop();
  }
});

test("saldo < $1 (402 untuk video): pakai audio + frame, lalu mode video dilewati sementara", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  videoWatch._reset();
  const calls = [];
  const http = {
    post: async (url, body) => {
      const parts = body.messages.at(-1).content;
      calls.push(parts.map((part) => part.type));
      if (parts.some((part) => part.type === "video_url")) throw Object.assign(new Error("Error HTTP OpenRouter (402): This request requires at least $1.00 in balance for video"), { status: 402 });
      return { choices: [{ message: { content: "Transkrip: rapat dipindah ke Jumat" } }], usage: { cost: 0.002 } };
    },
  };
  const seen = await videoWatch.watchVideo({ buffer: sampleVideo(3), question: "transkrip", http });
  assert.equal(seen.mode, "audio+frames");
  assert.match(seen.answer, /Jumat/);
  assert.ok(calls[1].includes("input_audio") && calls[1].includes("image_url"), "audio + frame");
  assert.equal(videoWatch.videoAllowed(), false);
  await videoWatch.watchVideo({ buffer: sampleVideo(2), question: "lagi", http });
  assert.ok(!calls[2].includes("video_url"), "tidak mencoba video lagi selama diblokir");
  videoWatch._reset();
});

test("mata gerak stiker: 402 video → frame berurutan", { skip: !hasFfmpeg && "ffmpeg tidak ada" }, async () => {
  videoWatch._reset();
  const motion = require("../ai/media/motion");
  motion._reset();
  const sharp = require("sharp");
  const pngs = await Promise.all([0, 1, 2, 3].map((i) => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: i * 60, g: 10, b: 10, alpha: 1 } } }).png().toBuffer()));
  const webp = await sharp(pngs, { join: { animated: true } }).webp({ delay: [100, 100, 100, 100], loop: 0 }).toBuffer();
  const kinds = [];
  const http = {
    post: async (url, body) => {
      const parts = body.messages[0].content;
      kinds.push(parts.map((part) => part.type));
      if (parts.some((part) => part.type === "video_url")) throw Object.assign(new Error("HTTP 402 requires at least $1.00 in balance for video"), { status: 402 });
      return { choices: [{ message: { content: JSON.stringify({ motion: "membanting tangan", emotion: "kesal", text_in_media: "", summary: "kucing membanting tangan, kesal" }) } }] };
    },
  };
  const result = await motion.describeMotion({ buffer: webp, http });
  assert.equal(result.summary, "kucing membanting tangan, kesal");
  assert.ok(kinds[1].filter((type) => type === "image_url").length >= 2, "frame berurutan");
  videoWatch._reset();
});
