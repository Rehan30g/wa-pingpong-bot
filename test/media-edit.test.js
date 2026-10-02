const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-media-edit-");
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const { editMedia } = require("../ai/media/media-edit");
const groupAgent = require("../ai/group-agent");
const features = require("../ai/features");

test.after(() => cleanup());

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
const opts = { skip: hasFfmpeg ? false : "ffmpeg tidak terpasang" };
const WORK = path.join(testDir, "work");
const GROUP = "120363456000111@g.us";

function makeVideo(name, seconds = 6) {
  fs.mkdirSync(WORK, { recursive: true });
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=640x360:rate=25`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(WORK, name)], { windowsHide: true });
  return name;
}

test("stiker animasi, GIF bertulisan, mp3 dipercepat, frame, kompres, gabung", opts, async () => {
  const video = makeVideo("in.mp4");
  makeVideo("in2.mp4", 3);
  const sticker = await editMedia({ workdir: WORK, inputs: [video], steps: [{ op: "trim", start: 1, end: 5 }], output: "sticker" });
  assert.equal(sticker.files[0].kind, "sticker");
  assert.ok(sticker.files[0].size < 1_000_000);
  assert.equal(fs.readFileSync(sticker.files[0].path).toString("ascii", 8, 12), "WEBP");

  // Teks dengan karakter khusus sintaks filter tetap aman (lewat textfile).
  const gif = await editMedia({ workdir: WORK, inputs: [video], steps: [{ op: "text", text: "Grad: 100% 'keren' \\ ,;[x]", position: "top" }], output: "gif" });
  assert.equal(gif.files[0].kind, "gif");

  const mp3 = await editMedia({ workdir: WORK, inputs: [video], steps: [{ op: "speed", factor: 2 }], output: "mp3" });
  assert.equal(mp3.files[0].mime, "audio/mpeg");
  assert.equal(mp3.info.duration, 3);

  const frames = await editMedia({ workdir: WORK, inputs: [video], output: "frames", frames: 3 });
  assert.equal(frames.files.length, 3);

  const compressed = await editMedia({ workdir: WORK, inputs: [video], steps: [{ op: "mute" }], output: "compress", targetMb: 1 });
  assert.ok(compressed.files[0].size < 1.2 * 1_048_576);

  const joined = await editMedia({ workdir: WORK, inputs: [video, "in2.mp4"], steps: [{ op: "concat" }], output: "mp4" });
  assert.ok(Math.abs(joined.info.duration - 9) < 0.5);
  assert.ok(!fs.readdirSync(WORK).some((name) => /_(concat|font|text)\b/.test(name)), "berkas bantu dibersihkan");
});

// Build ffmpeg tanpa drawtext (mis. statis 7.0.2 tanpa harfbuzz) harus memberi
// error yang bisa dijelaskan Grad, bukan "Filter not found".
test("operasi text ditolak jelas bila ffmpeg tidak punya drawtext", { skip: process.platform === "win32" ? "butuh skrip shell" : opts.skip }, async () => {
  makeVideo("in.mp4", 2);
  const fake = path.join(testDir, "ffmpeg-tanpa-drawtext.sh");
  fs.writeFileSync(fake, "#!/bin/sh\necho ' T.. null              V->V       Pass the source unchanged.'\n", { mode: 0o755 });
  const old = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = fake;
  try {
    await assert.rejects(editMedia({ workdir: WORK, inputs: ["in.mp4"], steps: [{ op: "text", text: "halo" }], output: "gif" }), /tidak mendukung tulisan/);
  } finally {
    if (old === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = old;
  }
});

test("penjaga: file di luar folder kerja, operasi/format tak dikenal, audio→stiker ditolak", opts, async () => {
  makeVideo("in.mp4", 2);
  await assert.rejects(editMedia({ workdir: WORK, inputs: ["../../.env"], output: "mp4" }), /di luar folder kerja/);
  await assert.rejects(editMedia({ workdir: WORK, inputs: ["in.mp4"], steps: [{ op: "rm -rf" }], output: "mp4" }), /operasi tidak dikenal/);
  await assert.rejects(editMedia({ workdir: WORK, inputs: ["in.mp4"], output: "exe" }), /format keluaran tidak dikenal/);
  await assert.rejects(editMedia({ workdir: WORK, inputs: ["in.mp4"], steps: [{ op: "trim", start: "5; rm", end: 1 }], output: "mp4" }), /waktu tidak valid/);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=2", path.join(WORK, "a.mp3")], { windowsHide: true });
  await assert.rejects(editMedia({ workdir: WORK, inputs: ["a.mp3"], output: "sticker" }), /butuh video/);
});

test("agent loop: 'jadiin stiker' → media_edit dari pesan # → stiker terkirim; fitur mati = tool tidak ada", opts, async () => {
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
  makeVideo("src.mp4", 4);
  const videoBuffer = fs.readFileSync(path.join(WORK, "src.mp4"));
  groupAgent.setRawMediaLoader(async (ref) => (ref?.key?.id === "vid" ? { buffer: videoBuffer, kind: "video", ext: "mp4" } : null));
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: ["Nih stikernya."] }).start();
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const base = { sock, groupId: GROUP, senderId: "62811", senderName: "Rehan", replyToBot: false, quotedText: "" };
    await groupAgent.processGroupMessage({ ...base, message: { key: { id: "vid", remoteJid: GROUP } }, text: "[mengirim video]", explicitMention: false, media: { type: "video", kind: "attachment", format: "video" } });
    const entry = groupAgent.getHistory(GROUP).find((e) => e.message_key?.id === "vid");
    mock.script.decision = { choice: "reply", confidence: 0.95 };
    mock.script.chat = [
      { content: null, tool_calls: [toolCall("media_edit", { sources: [{ entry_id: entry.entry_id }], steps: [{ op: "trim", start: 0, end: 3 }], output: "sticker" })] },
      "Nih stikernya.",
    ];
    const result = await groupAgent.processGroupMessage({ ...base, message: { key: { id: "ask", remoteJid: GROUP } }, text: "@Grad jadiin stiker video tadi", explicitMention: true });
    assert.equal(result.action, "reply");
    assert.equal(result.media.length, 1);
    assert.deepEqual(sent.slice(-2).map((s) => (s.sticker ? "STIKER" : s.text)), ["Nih stikernya.", "STIKER"]);

    features.setGroupFeature(GROUP, "edit_media", false, { role: "admin" });
    await groupAgent.processGroupMessage({ ...base, message: { key: { id: "ask2", remoteJid: GROUP } }, text: "@Grad jadiin gif", explicitMention: true });
    assert.ok(!(mock.state.chat.at(-1).tools || []).some((t) => t.function?.name === "media_edit"));
  } finally {
    groupAgent.setRawMediaLoader(null);
    await mock.stop();
  }
});
