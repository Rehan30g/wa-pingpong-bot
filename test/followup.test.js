const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-followup-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_AGENT_QUIET_START = "0";
process.env.AI_AGENT_QUIET_END = "0";

const test = require("node:test");
const assert = require("node:assert");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const proactive = require("../ai/agent/proactive");

test.after(() => cleanup());

const GROUP = "120363555000222@g.us";
const REHAN = "6281111110003";
const YOS = "6281111110002";
const MIN = 60_000;
const PRICE = "harga Xiaomi 14T sekarang kisaran Rp6,3–7 jt";

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push(content); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

let counter = 0;
const send = (sock, senderId, senderName, text, extra = {}) => groupAgent.processGroupMessage({
  sock, message: { key: { id: `f${++counter}`, remoteJid: GROUP } }, groupId: GROUP, senderId, senderName, text,
  explicitMention: false, replyToBot: false, quotedText: "", ...extra,
});
const userText = (request) => JSON.stringify(request.messages.filter((item) => item.role === "user"));

function priceAnswered(at = Date.now() - MIN) {
  groupAgent.resetHistories();
  proactive.reset();
  groupAgent.remember(GROUP, { sender: "Rehan", senderId: REHAN, text: "grad harga xiaomi 14t brp", at: at - 30_000 });
  groupAgent.remember(GROUP, { sender: "Grad", senderId: "BOT", isBot: true, text: PRICE, at });
}

test("lanjutan dialog: pesan tepat setelah Grad, atau beruntun dari orang yang sama ≤3 menit", () => {
  const now = Date.now();
  const bot = { is_bot: true, sender_id: "BOT", at: now - MIN };
  const r = (text, at = now, id = REHAN) => ({ sender_id: id, text, at });
  assert.equal(groupAgent.continuesBotDialogue([bot, r("gile")]), true, "tepat setelah Grad");
  assert.equal(groupAgent.continuesBotDialogue([bot, r("gile", now - 30_000), r("MAHAL")]), true, "beruntun orang sama");
  assert.equal(groupAgent.continuesBotDialogue([bot, r("gile", now - 30_000), r("eh main yuk", now, YOS)]), false, "orang lain menyela");
  assert.equal(groupAgent.continuesBotDialogue([{ ...bot, at: now - 5 * MIN }, r("gile", now - 4 * MIN), r("MAHAL")]), false, "lewat 3 menit");
  assert.equal(groupAgent.continuesBotDialogue([r("halo"), r("lagi")]), false, "belum ada Grad");
});

test("Jev bilang diam untuk lanjutan dialog → GLM tetap memutuskan (balas / diam)", async () => {
  priceAnswered();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.8 }, chat: ["iya mahal, flagship sih 😅", "mending tunggu promo"] }).start();
  try {
    const sock = makeSock();
    const gile = await send(sock, REHAN, "Rehan", "Gile");
    assert.equal(gile.action, "reply");
    assert.match(userText(mock.state.chat[0]), /melanjutkan obrolan denganmu tapi belum tentu butuh balasan/);
    assert.match(JSON.stringify(mock.state.chat[0].messages[0]), /'ha'\/'hah' = kaget/);
    const mahal = await send(sock, REHAN, "Rehan", "MAHAL");
    assert.equal(mahal.action, "reply", "pesan beruntun orang yang sama tetap lanjutan dialog");
    assert.equal(mock.state.chat.length, 2);

    // Orang lain menyela dan Jev bilang diam → GLM tidak dipanggil.
    const other = await send(sock, YOS, "Yos", "eh nanti jadi main?");
    assert.equal(other.action, "ignore");
    assert.equal(mock.state.chat.length, 2);
  } finally {
    await mock.stop();
  }
});

test("lanjutan dialog yang tidak butuh tanggapan → GLM stay_silent, tidak ada yang terkirim", async () => {
  priceAnswered();
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: [{ content: null, tool_calls: [toolCall("stay_silent", { reason: "bukan_untukku" })] }] }).start();
  try {
    const sock = makeSock();
    const result = await send(sock, REHAN, "Rehan", "yos sini dulu");
    assert.equal(result.action, "silent");
    assert.equal(sock.sent.filter((item) => item.text).length, 0);
  } finally {
    await mock.stop();
  }
});

test("lewat jendela 3 menit dan bukan pesan tepat setelah Grad → Jev diam tetap diam", async () => {
  priceAnswered(Date.now() - 6 * MIN);
  groupAgent.remember(GROUP, { sender: "Rehan", senderId: REHAN, text: "hmm", at: Date.now() - 5 * MIN });
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: ["x"] }).start();
  try {
    const result = await send(makeSock(), REHAN, "Rehan", "gile");
    assert.equal(result.action, "ignore");
    assert.equal(mock.state.chat.length, 0);
  } finally {
    await mock.stop();
  }
});

test("reply ke pesan Grad: riwayat ditandai ↩#id dan prompt menyebut PESANMU SENDIRI (via stanzaId & cadangan teks)", async () => {
  groupAgent.resetHistories();
  proactive.reset();
  const now = Date.now();
  groupAgent.remember(GROUP, { sender: "Rehan", senderId: REHAN, text: "grad harga xiaomi 14t brp", at: now - 90_000 });
  const bot = groupAgent.remember(GROUP, { sender: "Grad", senderId: "BOT", isBot: true, text: PRICE, at: now - 60_000, messageKey: { id: "BOTMSG1" } });
  groupAgent.remember(GROUP, { sender: "Yos", senderId: YOS, text: "wkwk", at: now - 30_000 });
  const mock = await createMockOpenRouter({ decision: { choice: "reply", confidence: 0.9 }, chat: ["iya kan, kemahalan buat HP setahun lalu 😅"] }).start();
  try {
    // WhatsApp mengirim stanzaId pesan yang di-reply di contextInfo.
    const message = { key: { id: "u1", remoteJid: GROUP }, message: { extendedTextMessage: { text: "Tau ga", contextInfo: { stanzaId: "BOTMSG1", quotedMessage: { conversation: PRICE } } } } };
    await groupAgent.processGroupMessage({ sock: makeSock(), message, groupId: GROUP, senderId: REHAN, senderName: "Rehan", text: "Tau ga", explicitMention: false, replyToBot: true, quotedText: PRICE });
    const text = userText(mock.state.chat[0]);
    assert.ok(text.includes(`Rehan [${REHAN}] ↩#${bot.entry_id}: Tau ga`), "baris riwayat bertanda ↩#id");
    assert.ok(text.includes(`Pesan terbaru me-reply (PESANMU SENDIRI #${bot.entry_id}): harga Xiaomi 14T`), "prompt menyebut pesan Grad sendiri");

    // Tanpa stanzaId: cocokkan lewat teks yang sama persis.
    const quoted = groupAgent.findQuotedEntry(groupAgent.getHistory(GROUP), { quotedText: PRICE });
    assert.equal(quoted.entry_id, bot.entry_id);
    // Reply ke pesan manusia: disebut pengirimnya.
    const yos = groupAgent.getHistory(GROUP).find((item) => item.text === "wkwk");
    const line = groupAgent.quotedLine([...groupAgent.getHistory(GROUP), { entry_id: 999, reply_to_entry: yos.entry_id }], "wkwk");
    assert.match(line, /\(dari Yos, #\d+\)/);
  } finally {
    await mock.stop();
  }
});
