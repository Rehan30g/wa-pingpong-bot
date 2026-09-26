const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-background-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const background = require("../ai/agent/background");

test.after(() => cleanup());

const GROUP = "120363321000111@g.us";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content, options) => { sent.push({ jid, ...content, options }); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

let counter = 0;
const args = (sock, text) => ({ sock, message: { key: { id: `r${++counter}`, remoteJid: GROUP } }, groupId: GROUP, senderId: "628111222333", senderName: "Rehan", text, explicitMention: true, replyToBot: false, quotedText: "" });

async function until(check, timeoutMs = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout menunggu");
    await sleep(20);
  }
}

test("tugas latar: Grad langsung ack, subagent bekerja di belakang, hasil me-reply permintaan; chat tidak terblokir", async () => {
  background.reset();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("start_background_task", { goal: "bandingkan 5 HP flagship 2026 dan buat tabel ringkas" })] },
      "Oke, aku kerjain dulu ya, nanti kukabari.",
      { content: "*Perbandingan 5 flagship*\n• A\n• B", delayMs: 300 },
      "Halo juga!",
    ],
  }).start();
  try {
    const sock = makeSock();
    const request = args(sock, "@Grad bandingin 5 hp flagship 2026 lengkap ya");
    const ack = await groupAgent.processGroupMessage(request);
    assert.equal(ack.action, "reply");
    assert.equal(sock.sent[0].text, "Oke, aku kerjain dulu ya, nanti kukabari.");
    assert.equal(background.listForChat(GROUP).length, 1);

    // Chat lain tetap jalan saat subagent bekerja (antrean chat → pesan berikutnya).
    await sleep(50);
    mock.script.chat.splice(0, mock.script.chat.length - 1, "Halo juga!");
    const chat = await groupAgent.processGroupMessage(args(sock, "@Grad halo"));
    assert.equal(chat.action, "reply");

    await until(() => sock.sent.some((s) => /Perbandingan 5 flagship/.test(s.text || "")));
    const result = sock.sent.find((s) => /Perbandingan 5 flagship/.test(s.text || ""));
    assert.equal(result.options.quoted.key.id, request.message.key.id, "hasil me-reply permintaan asli");
    const subagentRequest = mock.state.chat.find((c) => JSON.stringify(c.messages).includes("Tugas latar dari Rehan"));
    assert.ok(subagentRequest, "subagent mendapat tugasnya");
    assert.ok(!(subagentRequest.tools || []).some((t) => ["start_background_task", "background_tasks"].includes(t.function?.name)), "subagent tidak bisa memulai subagent lagi");
    await until(() => background.listForChat(GROUP).length === 0);
  } finally {
    await mock.stop();
  }
});

test("pembatalan: hasil tugas latar yang dibatalkan tidak dikirim; batas tugas per chat", async () => {
  background.reset();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({ chat: [{ content: "hasil yang tidak boleh terkirim", delayMs: 400 }] }).start();
  try {
    const sock = makeSock();
    const control = groupAgent.makeBackgroundControl({ chatId: GROUP, historyKey: GROUP, isDm: false, latestMessage: { sender: "Rehan", sender_id: "628111" }, requestRef: null, sock });
    const first = control.start({ goal: "riset panjang A" });
    const second = control.start({ goal: "riset panjang B" });
    assert.ok(first.ok && second.ok);
    assert.match(control.start({ goal: "riset C" }).error, /sudah ada 2 tugas latar/);
    assert.deepEqual(control.list().map((t) => t.goal), ["riset panjang A", "riset panjang B"]);
    assert.equal(control.cancel(first.id).ok, true);
    assert.equal(control.cancel(second.id).ok, true);
    await sleep(700);
    assert.ok(!sock.sent.some((s) => /tidak boleh terkirim/.test(s.text || "")));
  } finally {
    await mock.stop();
  }
});
