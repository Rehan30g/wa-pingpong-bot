const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-dm-group-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_DM_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_DM_MIN_DELAY_MS = "0";
process.env.AI_DM_MAX_DELAY_MS = "0";
process.env.DM_SHARE_DELAY_MS = "600000"; // ekstraksi otomatis tidak jalan di tengah tes

const test = require("node:test");
const assert = require("node:assert");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");
const mentions = require("../ai/agent/mentions");
const relay = require("../ai/agent/group-relay");

test.after(() => cleanup());

const GROUP = "120363555000111@g.us";
const OTHER_GROUP = "120363555000222@g.us";
const REHAN = "628111000111";
const ANI = "628222000222";
const BUDI = "628333000333";

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

function seedPeople() {
  memoryStore.resetAllMemory();
  groupAgent.resetHistories();
  relay.reset();
  const at = groupAgent.witTimestamp();
  memoryStore.recordParticipant({ phone: REHAN, name: "Rehan", groupId: GROUP, at });
  memoryStore.recordParticipant({ phone: ANI, name: "Ani Lestari", groupId: GROUP, at });
  memoryStore.recordParticipant({ phone: BUDI, name: "Budi", groupId: OTHER_GROUP, at });
  groupAgent.setGroupDirectory(async () => [{ id: GROUP, subject: "Yy" }, { id: OTHER_GROUP, subject: "Kelas B" }]);
}

// ---------- tag orang ----------
test("tag: @Nama jadi mention sungguhan (nama depan unik), @semua tidak pernah, maks 3, nimbrung tanpa tag", async () => {
  seedPeople();
  mentions.setMentionJidResolver(async (groupId, phone) => `${phone}@lid`);
  try {
    const one = await mentions.applyMentions(GROUP, "@Ani jangan lupa bawa proyektor ya, @semua juga siap-siap");
    assert.equal(one.text, `@${ANI} jangan lupa bawa proyektor ya, semua juga siap-siap`);
    assert.deepEqual(one.mentions, [`${ANI}@lid`]);
    const unknown = await mentions.applyMentions(GROUP, "@Budi kamu di mana");
    assert.deepEqual([unknown.text, unknown.mentions], ["Budi kamu di mana", []], "Budi bukan anggota grup ini");
    const quiet = await mentions.applyMentions(GROUP, "@Ani wkwk", { allow: false });
    assert.deepEqual([quiet.text, quiet.mentions], ["Ani wkwk", []]);
    const many = await mentions.applyMentions(GROUP, "@Ani @Rehan @Ani", { max: 1 });
    assert.equal(many.mentions.length, 1);
    assert.equal(mentions.matchMember([{ phone: "1", names: ["Ani A"] }, { phone: "2", names: ["Ani B"] }], "Ani"), null, "nama depan ambigu tidak ditag");
  } finally {
    mentions.setMentionJidResolver(null);
  }
});

test("tag di balasan grup: GLM menulis @Ani → dikirim dengan mentions", async () => {
  seedPeople();
  const mock = await createMockOpenRouter({ chat: ["@Ani udah diingetin ya, bayar kas hari ini"] }).start();
  try {
    const sock = makeSock();
    await groupAgent.processGroupMessage({ sock, message: { key: { id: "t1", remoteJid: GROUP } }, groupId: GROUP, senderId: REHAN, senderName: "Rehan", text: "@Grad tolong ingetin Ani bayar kas", explicitMention: true, replyToBot: false, quotedText: "" });
    const sent = sock.sent.find((item) => item.text);
    assert.equal(sent.text, `@${ANI} udah diingetin ya, bayar kas hari ini`);
    assert.deepEqual(sent.mentions, [`${ANI}@s.whatsapp.net`]);
    assert.match(JSON.stringify(mock.state.chat[0].messages[0]), /tulis @Nama/);
  } finally {
    await mock.stop();
  }
});

// ---------- titip pesan DM → grup ----------
test("titip pesan: biasa langsung antre; tag/nagih jadi draf; konfirmasi mengirim draf asli; grup asing/massal/kuota ditolak", () => {
  relay.reset();
  const base = () => ({ phone: REHAN, name: "Rehan", groups: [{ id: GROUP, subject: "Yy" }], queue: [] });
  const r1 = base();
  assert.equal(relay.request(r1, { text: "aku telat 15 menit" }).ok, true);
  assert.deepEqual(r1.queue, [{ groupId: GROUP, subject: "Yy", text: "aku telat 15 menit" }]);

  const r2 = base();
  const draft = relay.request(r2, { group: "yy", text: "@Ani jangan lupa bayar kas ya" });
  assert.equal(draft.needs_confirmation, true);
  assert.equal(draft.preview, "Rehan titip pesan: @Ani jangan lupa bayar kas ya");
  assert.equal(r2.queue.length, 0);
  assert.match(relay.request(r2, { confirm_draft: "salah" }).error, /tidak ada draf yang menunggu/);
  assert.equal(relay.request({ ...base(), queue: [] }, { text: "Rehan titip pesan: aku telat" }).text, "aku telat", "awalan dobel dibuang");
  const nextTurn = { ...base(), queue: [] };
  const confirmed = relay.request(nextTurn, { confirm_draft: draft.draft_id, text: "isi lain yang diselundupkan" });
  assert.equal(confirmed.ok, true);
  assert.equal(nextTurn.queue[0].text, "@Ani jangan lupa bayar kas ya", "yang dikirim draf asli");

  assert.match(relay.request(base(), { group: "Kelas B", text: "halo" }).error, /bukan grup yang dia ikuti/);
  assert.match(relay.request(base(), { text: "@semua kumpul" }).error, /tag semua/);
  for (let i = 0; i < 5; i++) relay.markSent(REHAN);
  assert.match(relay.request(base(), { text: "lagi" }).error, /kuota/);
  relay.reset();
});

test("DM: Grad tahu obrolan grup yang diikuti, bisa titip pesan atas nama pengirim (tanpa menyamar)", async () => {
  seedPeople();
  groupAgent.remember(GROUP, { sender: "Ani Lestari", senderId: ANI, text: "besok rapat jam 10 di ruang 2 ya" });
  groupAgent.remember(OTHER_GROUP, { sender: "Budi", senderId: BUDI, text: "rahasia kelas B" });
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("tell_group", { text: "aku telat ke rapat besok, mulai aja duluan" })] },
      "udah aku sampein ke grup Yy",
    ],
  }).start();
  try {
    const sock = makeSock();
    await directAgent.processDirectMessage({ sock, message: { key: { id: "d1" } }, phone: REHAN, senderName: "Rehan", text: "grad bilang ke grup aku telat ke rapat besok" });
    const prompt = JSON.stringify(mock.state.chat[0].messages);
    assert.match(prompt, /=== Yy ===/);
    assert.match(prompt, /besok rapat jam 10 di ruang 2/);
    assert.ok(!prompt.includes("rahasia kelas B"), "grup yang tidak dia ikuti tidak bocor");
    assert.match(prompt, /tolak santai/);
    assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "tell_group"));

    const toGroup = sock.sent.filter((item) => item.jid === GROUP);
    assert.deepEqual(toGroup.map((item) => item.text), ["Rehan titip pesan: aku telat ke rapat besok, mulai aja duluan"]);
    assert.ok(sock.sent.some((item) => item.jid !== GROUP && item.text === "udah aku sampein ke grup Yy"));
    assert.equal(groupAgent.getHistory(GROUP).at(-1).text, "Rehan titip pesan: aku telat ke rapat besok, mulai aja duluan");
  } finally {
    await mock.stop();
  }
});

// ---------- DM → grup (fakta tersaring) ----------
test("saringan privasi: kesehatan/uang/asmara/pendapat soal member selalu privat kecuali diizinkan jelas", () => {
  const facts = directAgent.shareableFilter([
    { fact: "lagi bikin QR buat acara", category: "tugas_rencana", public_ok: true, user_allowed_share: false },
    { fact: "suka kopi susu", category: "selera_hobi", public_ok: false, user_allowed_share: false },
    { fact: "lagi sakit maag", category: "kesehatan_mental", public_ok: true, user_allowed_share: false },
    { fact: "kesel sama Ani", category: "tentang_member_lain", public_ok: true, user_allowed_share: false },
    { fact: "baru jadian", category: "asmara_keluarga", public_ok: true, user_allowed_share: true },
    { fact: "utang 2 juta", category: "keuangan", public_ok: true, user_allowed_share: false },
  ]);
  assert.deepEqual(facts.map((item) => item.fact), ["lagi bikin QR buat acara", "baru jadian"]);
});

test("ekstraksi fakta DM → hanya yang lolos saringan dipakai di prompt grup (tidak saat nimbrung)", async () => {
  seedPeople();
  groupAgent.remember(`dm:${REHAN}`, { sender: "Rehan", senderId: REHAN, text: "aku lagi bikin QR buat acara kampus, btw aku lagi sakit maag" });
  groupAgent.remember(`dm:${REHAN}`, { sender: "Grad", senderId: "BOT", text: "semoga cepet sembuh", isBot: true });
  const fakeGlm = { chatCompletion: async () => ({ text: JSON.stringify({ facts: [
    { fact: "lagi bikin QR buat acara kampus", category: "tugas_rencana", public_ok: true, user_allowed_share: false },
    { fact: "lagi sakit maag", category: "kesehatan_mental", public_ok: true, user_allowed_share: false },
  ] }) }) };
  const fresh = await directAgent.extractShareableFacts(REHAN, { glm: fakeGlm });
  assert.deepEqual(fresh.map((item) => item.fact), ["lagi bikin QR buat acara kampus"]);
  assert.deepEqual(await directAgent.extractShareableFacts(REHAN, { glm: fakeGlm }), [], "tidak memindai ulang pesan lama");

  groupAgent.remember(GROUP, { sender: "Rehan", senderId: REHAN, text: "guys acara kampus jadi minggu depan" });
  const block = groupAgent.sharedDmFactsFor(groupAgent.getHistory(GROUP));
  assert.match(block, /Rehan: lagi bikin QR buat acara kampus/);
  assert.match(block, /kemarin kamu sempet cerita ke aku/);
  assert.ok(!block.includes("maag"));

  const social = groupAgent.buildChatMessages({ groupId: GROUP, latestMessage: { sender: "Rehan", sender_id: REHAN, text: "wkwk" }, historySnapshot: groupAgent.getHistory(GROUP), proactiveMode: "social" });
  assert.ok(!JSON.stringify(social).includes("buat acara kampus («"), "nimbrung tidak memakai fakta DM");
  assert.ok(!JSON.stringify(social).includes("lewat chat berdua"));
});

test("titip pesan: draf tidak bisa dikonfirmasi model di giliran yang sama; 'dibayar' terdeteksi sensitif", () => {
  relay.reset();
  const turn1 = { phone: REHAN, name: "Rehan", groups: [{ id: GROUP, subject: "Yy" }], queue: [] };
  const draft = relay.request(turn1, { text: "Ani, kas yang kurang 50rb jangan lupa dibayar ya" });
  assert.equal(draft.needs_confirmation, true);
  assert.match(relay.request(turn1, { confirm: true }).error, /tunggu dia setuju di pesan berikutnya/);
  assert.equal(turn1.queue.length, 0);
  const turn2 = { ...turn1, queue: [] };
  assert.equal(relay.request(turn2, { confirm: true }).ok, true);
  assert.equal(turn2.queue.length, 1);
  assert.match(relay.request({ ...turn1, queue: [] }, { confirm: true }).error, /tidak ada draf/, "draf hanya sekali pakai");
  relay.reset();
});
