const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-members-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const memoryStore = require("../ai/memory-store");
const members = require("../ai/agent/members");
const mentions = require("../ai/agent/mentions");
const identity = require("../ai/agent/identity");

test.after(() => { members.setGroupMembersProvider(null); cleanup(); });

const GROUP = "120363555000333@g.us";
const REHAN = "6281111110003";
const TAM = "6281111110002";
const JUAN = "6281111110004";

function makeSock() {
  const sent = [];
  return { sent, sendMessage: async (jid, content) => { sent.push(content); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
}

function setup() {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  members.reset();
  identity.noteOwner({ phone: REHAN, name: "Rehannn" });
  memoryStore.recordParticipant({ phone: REHAN, name: "Rehannn", groupId: GROUP });
  memoryStore.recordParticipant({ phone: TAM, name: "Bima -Sakti", groupId: GROUP });
  // Metadata WA: Kak Juan belum pernah chat; satu anggota hanya dikenal lewat LID.
  members.setGroupMembersProvider(async () => [
    { phone: REHAN, name: null, admin: true },
    { phone: TAM, name: null },
    { phone: JUAN, name: "Kak Juan" },
    { phone: null, lid: true, name: null },
  ]);
}

test("prompt grup memuat daftar anggota (metadata WA + nama yang diingat), owner & yang belum dikenal", async () => {
  setup();
  const mock = await createMockOpenRouter({ chat: ["ada Rehannn, Bima -Sakti, Kak Juan"] }).start();
  try {
    await groupAgent.processGroupMessage({ sock: makeSock(), message: { key: { id: "m1", remoteJid: GROUP } }, groupId: GROUP, senderId: REHAN, senderName: "Rehannn", text: "@Grad siapa aja org di grup ini?", explicitMention: true, replyToBot: false, quotedText: "" });
    const prompt = JSON.stringify(mock.state.chat[0].messages);
    assert.match(prompt, /Anggota grup ini menurut WhatsApp: 4 orang/);
    assert.match(prompt, /Rehannn \(owner\)/);
    assert.match(prompt, /Bima -Sakti/);
    assert.match(prompt, /Kak Juan/, "anggota yang belum pernah chat ikut");
    assert.match(prompt, /1 lainnya belum pernah chat/);
  } finally {
    await mock.stop();
  }
});

test("remember_alias: 'bim itu Bima -Sakti' → @Bim men-tag orang yang benar; ambigu/tidak ketemu ditolak", async () => {
  setup();
  await members.groupMembers(GROUP, { fresh: true });
  const saved = await members.rememberAlias(GROUP, { member: "Bima -Sakti", alias: "Bim" });
  assert.equal(saved.ok, true);
  assert.deepEqual(memoryStore.getPerson(TAM).nicknames, ["Bim"]);
  await members.groupMembers(GROUP, { fresh: true });
  const tagged = await mentions.applyMentions(GROUP, "@Bim ditanya owner tuh");
  assert.deepEqual(tagged.mentions, [`${TAM}@s.whatsapp.net`]);
  assert.match(members.membersPromptLine(await members.groupMembers(GROUP)), /Bima -Sakti \(dipanggil: Bim\)/);

  assert.match((await members.rememberAlias(GROUP, { member: "Budi", alias: "Bud" })).error, /tidak ketemu/);
  assert.match((await members.rememberAlias(GROUP, { member: "Kak Juan", alias: "Bim" })).error, /sudah dipakai/);
  assert.equal(memoryStore.canDirectMessage(JUAN), false, "alias tidak memasukkan orang ke whitelist DM");
});

test("tool remember_alias lewat agent loop, lalu tag nama lengkap dua kata tanpa sisa teks", async () => {
  setup();
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("remember_alias", { member: "Bima -Sakti", alias: "Bim" })] }, "oke, @Bima -Sakti sekarang aku panggil Bim"] }).start();
  try {
    const sock = makeSock();
    await groupAgent.processGroupMessage({ sock, message: { key: { id: "m2", remoteJid: GROUP } }, groupId: GROUP, senderId: REHAN, senderName: "Rehannn", text: "@Grad bim itu Bima -Sakti ya", explicitMention: true, replyToBot: false, quotedText: "" });
    assert.ok(mock.state.chat[0].tools.some((tool) => tool.function?.name === "remember_alias"));
    assert.deepEqual(memoryStore.getPerson(TAM).nicknames, ["Bim"]);
    const reply = sock.sent.find((item) => item.text);
    assert.equal(reply.text, `oke, @${TAM} sekarang aku panggil Bim`, "nama dua kata ditag utuh, tanpa '-Sakti' tertinggal");
    assert.deepEqual(reply.mentions, [`${TAM}@s.whatsapp.net`]);
  } finally {
    await mock.stop();
  }
});

test("tag: kata mana pun dari nama bila unik; nama ambigu tidak ditag", async () => {
  setup();
  memoryStore.recordParticipant({ phone: "6281111110005", name: "Kak Sari", groupId: GROUP });
  memoryStore.recordParticipant({ phone: JUAN, name: "Kak Juan", groupId: GROUP });
  members.setGroupMembersProvider(null);
  await members.groupMembers(GROUP, { fresh: true });
  assert.deepEqual((await mentions.applyMentions(GROUP, "@Sakti woi")).mentions, [`${TAM}@s.whatsapp.net`]);
  assert.deepEqual((await mentions.applyMentions(GROUP, "@Juan sini")).mentions, [`${JUAN}@s.whatsapp.net`]);
  const ambiguous = await mentions.applyMentions(GROUP, "@Kak sini");
  assert.deepEqual(ambiguous.mentions, []);
});

const pythonReady = require("../ai/sandbox/python-runner").isReady();
test("skill ber-`web: false` (cuaca): setelah use_skill, web_search dicabut dari langkah berikutnya", { skip: pythonReady ? false : "sandbox belum disiapkan" }, async () => {
  setup();
  const mock = await createMockOpenRouter({ chat: [{ content: null, tool_calls: [toolCall("use_skill", { name: "cuaca" })] }, "Nabire cerah, 32°C"] }).start();
  try {
    await groupAgent.processGroupMessage({ sock: makeSock(), message: { key: { id: "w1", remoteJid: GROUP } }, groupId: GROUP, senderId: REHAN, senderName: "Rehannn", text: "@Grad cuaca Nabire hari ini", explicitMention: true, replyToBot: false, quotedText: "" });
    const hasWeb = (request) => (request.tools || []).some((tool) => tool.type === "openrouter:web_search");
    assert.equal(hasWeb(mock.state.chat[0]), true, "sebelum skill: web_search masih ada");
    assert.equal(hasWeb(mock.state.chat[1]), false, "setelah skill cuaca: tanpa web_search");
  } finally {
    require("../ai/sandbox/python-runner").stopWarmWorkers();
    await mock.stop();
  }
});

test("grup LID (metadata tanpa nomor HP): orang yang pernah chat tetap dikenali, tidak dihitung dobel, bisa diberi nama panggilan", async () => {
  memoryStore.resetAllMemory();
  members.reset();
  memoryStore.recordParticipant({ phone: TAM, name: "Bima -Sakti", groupId: GROUP });
  members.setGroupMembersProvider(async () => [{ lid: true }, { lid: true }, { lid: true, name: "Natasya" }]);
  const list = await members.groupMembers(GROUP, { fresh: true });
  assert.equal(list.length, 3, "1 dikenal + Natasya + 1 LID tanpa nama (LID Bim tidak dihitung dua kali)");
  assert.deepEqual(await members.learnNicknames(GROUP, [{ phone: TAM, nickname: "Bim" }]), [{ phone: TAM, nickname: "Bim" }]);
});
