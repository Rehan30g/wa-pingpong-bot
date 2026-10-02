const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-dm-relay-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_DM_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");

test.after(() => cleanup());

const GROUP = "120363789000111@g.us";
const REHAN = "628111222333";
const STRANGER_IN_GROUP = "628999888777";

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

const args = (sock, senderId, text) => ({ sock, message: { key: { id: `m${Math.random()}`, remoteJid: GROUP } }, groupId: GROUP, senderId, senderName: "Rehan", text, explicitMention: true, replyToBot: false, quotedText: "" });

test("'kirim ke DM aku': teks masuk DM peminta, grup hanya dapat konfirmasi singkat", async () => {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  memoryStore.recordParticipant({ phone: REHAN, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("send_to_my_dm", { text: "Ringkasan rapat:\n• Demo Minggu jam 10\n• Budi bawa proyektor" })] },
      "Udah kukirim ke DM kamu ya.",
    ],
  }).start();
  try {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(args(sock, REHAN, "@Grad ringkas rapat tadi, kirim ke DM aku aja"));
    assert.equal(result.action, "reply");
    assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "send_to_my_dm"));
    assert.deepEqual(sock.sent.map((s) => [s.jid, s.text]), [
      [GROUP, "Udah kukirim ke DM kamu ya."],
      [`${REHAN}@s.whatsapp.net`, "Ringkasan rapat:\n• Demo Minggu jam 10\n• Budi bawa proyektor"],
    ]);
    assert.ok(groupAgent.getHistory(`dm:${REHAN}`).some((e) => e.is_bot && /Ringkasan rapat/.test(e.text)), "tercatat di riwayat DM");
  } finally {
    await mock.stop();
  }
});

test("tidak ditawarkan untuk peminta di luar whitelist/opt-out, dan tidak ada di chat DM", async () => {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({ chat: ["oke"] }).start();
  try {
    await groupAgent.processGroupMessage(args(makeSock(), STRANGER_IN_GROUP, "@Grad kirim ke DM aku"));
    assert.ok(!mock.state.chat[0].tools.some((t) => t.function?.name === "send_to_my_dm"), "belum di whitelist");

    memoryStore.recordParticipant({ phone: REHAN, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
    memoryStore.setDmMemory(REHAN, { opt_out: true });
    await groupAgent.processGroupMessage(args(makeSock(), REHAN, "@Grad kirim ke DM aku"));
    assert.ok(!mock.state.chat[1].tools.some((t) => t.function?.name === "send_to_my_dm"), "opt-out dihormati");

    memoryStore.setDmMemory(REHAN, { opt_out: false });
    await directAgent.processDirectMessage({ sock: makeSock(), message: { key: { id: "d1" } }, phone: REHAN, senderName: "Rehan", text: "kirim ke DM aku" });
    assert.ok(!mock.state.chat[2].tools.some((t) => t.function?.name === "send_to_my_dm"), "sudah di DM");
  } finally {
    await mock.stop();
  }
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;
test("include_results: hasil media dipindah ke DM, tidak dikirim ke grup", { skip: hasFfmpeg ? false : "ffmpeg tidak ada" }, async () => {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  memoryStore.recordParticipant({ phone: REHAN, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });
  const src = path.join(testDir, "src.mp4");
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", src], { windowsHide: true });
  groupAgent.setRawMediaLoader(async () => ({ buffer: fs.readFileSync(src), kind: "video", ext: "mp4" }));
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: ["x"] }).start();
  try {
    const sock = makeSock();
    await groupAgent.processGroupMessage({ ...args(sock, REHAN, "[mengirim video]"), explicitMention: false });
    const entry = groupAgent.getHistory(GROUP).at(-1);
    mock.script.decision = { choice: "reply", confidence: 0.95 };
    mock.script.chat = [
      { content: null, tool_calls: [toolCall("media_edit", { sources: [{ entry_id: entry.entry_id }], output: "gif" }), toolCall("send_to_my_dm", { include_results: true })] },
      "Udah, GIF-nya kukirim ke DM.",
    ];
    await groupAgent.processGroupMessage(args(sock, REHAN, "@Grad jadiin gif, kirim ke DM aku"));
    const toGroup = sock.sent.filter((s) => s.jid === GROUP);
    const toDm = sock.sent.filter((s) => s.jid === `${REHAN}@s.whatsapp.net`);
    assert.deepEqual(toGroup.map((s) => s.text), ["Udah, GIF-nya kukirim ke DM."]);
    assert.equal(toDm.length, 1);
    assert.equal(toDm[0].gifPlayback, true);
  } finally {
    groupAgent.setRawMediaLoader(null);
    await mock.stop();
  }
});

// Kasus nyata 27 Sep: "buat jadi ungu dan kuning, tapi yang kuning kirim ke DM gw" →
// semua hasil pindah ke DM, grup kosong, dan Grad mengklaim yang kuning terkirim.
test("send_to_my_dm files: hanya file yang disebut ke DM, sisanya tetap ke grup; pembagian dilaporkan", async () => {
  const { executeTool } = require("../ai/agent/tools");
  const ungu = { name: "qr_ungu.png", path: "/x/out/qr_ungu.png", kind: "image" };
  const kuning = { name: "qr_kuning.png", path: "/x/out/qr_kuning.png", kind: "image" };
  const ctx = { dmRelay: { phone: REHAN, texts: [], moveResults: false, moveFiles: new Set() }, outbox: { media: [ungu] } };
  const call = (args) => executeTool({ name: "send_to_my_dm", ok: true, arguments: args }, ctx).then((r) => JSON.parse(r.content).result);

  const early = await call({ files: ["out/qr_kuning.png"] });
  assert.match(early.error, /belum ada di hasil tugas ini: qr_kuning\.png.*Hasil yang ada: qr_ungu\.png/);
  assert.equal(ctx.dmRelay.moveFiles.size, 0);

  ctx.outbox.media.push(kuning);
  const ok = await call({ text: "nih yang kuning", files: ["out/qr_kuning.png"] });
  assert.deepEqual([ok.dm_files, ok.group_files], [["qr_kuning.png"], ["qr_ungu.png"]]);

  const routed = groupAgent.splitRelayMedia({ media: ctx.outbox.media, dmRelay: ctx.dmRelay });
  assert.deepEqual([routed.chat.map((m) => m.name), routed.dm.map((m) => m.name)], [["qr_ungu.png"], ["qr_kuning.png"]]);
  assert.deepEqual(groupAgent.splitRelayMedia({ media: ctx.outbox.media, dmRelay: { ...ctx.dmRelay, moveResults: true } }).chat, [], "include_results tetap memindahkan semua");
  assert.deepEqual(groupAgent.splitRelayMedia({ media: [ungu], dmRelay: null }).dm, []);
});
