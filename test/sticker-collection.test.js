const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-stickercol-");
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const { getStickerCollector, resetStickerCollector } = require("../ai/stickers/collector");
const { getStickerLibrary } = require("../ai/stickers/library");
const curator = require("../ai/stickers/curator");
const groupAgent = require("../ai/group-agent");
const memoryStore = require("../ai/memory-store");

const GROUP_A = "120363111111111@g.us";
const GROUP_B = "120363222222222@g.us";
const OWNER = "628111111111";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.after(async () => {
  await resetStickerCollector();
  cleanup();
});

async function withEnv(vars, run) {
  const old = {};
  for (const [key, value] of Object.entries(vars)) {
    old[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const sha = (n) => Buffer.alloc(32, n);
const hex = (n) => sha(n).toString("hex");
const id = (n) => hex(n).slice(0, 8);

async function webp(color) {
  return sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).webp().toBuffer();
}

let storeCounter = 0;
// Setiap tes memakai DB stiker sendiri.
async function freshStore() {
  await resetStickerCollector();
  process.env.STICKER_DIR = path.join(testDir, `stickers-${++storeCounter}`);
  return { collector: getStickerCollector(), library: getStickerLibrary() };
}

async function seed(collector, n, { chat = GROUP_A, isDm = false, uses = 1, sender = "628222", at = Date.now(), color = { r: n * 20, g: 80, b: 120, alpha: 1 } } = {}) {
  const buffer = await webp(color);
  for (let i = 0; i < uses; i++) {
    await collector.observe({ chatId: chat, isDm, senderId: `${sender}${i}`, senderName: "Budi", text: "wkwk ngakak", at });
    await collector.observe({ chatId: chat, isDm, senderId: `${sender}${i}`, senderName: "Budi", sticker: { fileSha256: sha(n) }, download: async () => buffer, at });
  }
}

function fakeGlm(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    chatCompletion: async (request) => {
      calls.push(request);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { text: JSON.stringify(typeof next === "function" ? next(request) : next), cost: 0.002 };
    },
  };
}

const decision = (n, overrides = {}) => ({
  sticker_id: id(n), decision: "keep", safety: "ok", label: `stiker ${n}`, moods: ["laugh"],
  when_to_use: "saat ada yang lucu", planned_frequency: "sering", scope: "global", reason: "sering dipakai", ...overrides,
});

// ---------- kurasi ----------

test("kurasi harian: GLM melihat gambar + statistik, keputusan keep/skip tercatat, aturan keamanan menang", async () => {
  const { collector, library } = await freshStore();
  await seed(collector, 1, { uses: 3 });
  await seed(collector, 2);
  await seed(collector, 3);
  await seed(collector, 4, { chat: `${OWNER}@s.whatsapp.net`, isDm: true });
  const glm = fakeGlm([{
    decisions: [
      decision(1),
      decision(2, { decision: "skip", label: "random", moods: [], reason: "maknanya nggak jelas" }),
      decision(3, { safety: "nsfw", reason: "lucu sih" }),
    ],
    removals: [],
  }]);
  const summary = await curator.runCuration({ glm, library, botName: "Grad" });

  assert.equal(summary.considered, 4);
  const content = glm.calls[0].messages[1].content;
  assert.equal(content.filter((part) => part.type === "image_url").length, 4, "setiap kandidat dikirim sebagai gambar");
  assert.ok(content.every((part) => part.type !== "image_url" || part.image_url.url.startsWith("data:image/png;base64,")));
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, new RegExp(`Stiker ${id(1)}: dipakai manusia 3×`));
  assert.match(text, /wkwk ngakak/, "konteks grup ikut");
  assert.match(text, /1 pemakaian lain di chat pribadi; isinya tidak ditampilkan/, "isi konteks DM tidak dikirim");

  assert.deepEqual(summary.kept.map((k) => k.id), [id(1)]);
  assert.deepEqual(summary.skipped.map((s) => s.id).sort(), [id(2), id(3)].sort());
  assert.match(summary.skipped.find((s) => s.id === id(3)).reason, /aturan keamanan: nsfw/);
  const collection = await library.listCollection();
  assert.deepEqual(collection.map((s) => s.id), [id(1)]);
  assert.ok(fs.existsSync(path.join(collector.dir, collection[0].file)), "file disalin ke folder koleksi");
  assert.equal((await library.findSticker(id(4))).status, "candidate", "kandidat yang tidak dijawab GLM tetap menunggu");
  const decisions = await library.recentDecisions(10);
  assert.ok(decisions.some((d) => d.id === id(3) && d.kind === "skip" && d.source === "rule"));
});

test("kapasitas: GLM membuang seperlunya, sisanya ditolak karena koleksi penuh", async () => {
  await withEnv({ STICKER_CAPACITY: "2" }, async () => {
    const { collector, library } = await freshStore();
    for (const n of [1, 2]) await seed(collector, n);
    await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(1), decision(2)], removals: [] }]), library });
    for (const n of [3, 4]) await seed(collector, n);
    const summary = await curator.runCuration({
      glm: fakeGlm([{ decisions: [decision(3), decision(4)], removals: [{ sticker_id: id(1), reason: "basi" }] }]),
      library,
    });
    assert.deepEqual(summary.removed.map((r) => r.id), [id(1)]);
    assert.deepEqual(summary.kept.map((k) => k.id), [id(3)]);
    assert.deepEqual(summary.skipped.map((s) => [s.id, s.reason]), [[id(4), "koleksi penuh"]]);
    assert.deepEqual((await library.listCollection()).map((s) => s.id).sort(), [id(2), id(3)].sort());
    assert.match((await library.lastDecision(hex(1))).reason, /diganti kandidat baru: basi/);
  });
});

test("skip tidak dinilai ulang kecuali pemakaian manusia naik ≥3×; skip basi 30 hari dihapus dari disk", async () => {
  const { collector, library } = await freshStore();
  const old = Date.now() - 40 * DAY;
  await seed(collector, 5, { at: old });
  await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(5, { decision: "skip", reason: "jelek" })], removals: [] }]), library, at: old });
  const glm = fakeGlm([{ decisions: [], removals: [] }]);
  assert.equal((await curator.runCuration({ glm, library })).considered, 0);

  await seed(collector, 6, { at: old });
  await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(6, { decision: "skip", reason: "nggak kepake" })], removals: [] }]), library, at: old });
  await seed(collector, 5, { uses: 3 });
  const recheck = await curator.runCuration({ glm, library });
  assert.equal(recheck.considered, 1, "stiker 5 dinilai ulang karena pemakaian naik");
  assert.match(glm.calls.at(-1).messages[1].content.find((p) => p.type === "text" && p.text.includes(id(5))).text, /dinilai ulang/);
  assert.equal(recheck.purged, 1, "stiker 6 (skip, tidak muncul 40 hari) dihapus dari disk");
  const six = await library.findSticker(id(6));
  assert.equal(six.file, null);
});

test("review mingguan: buang dan revisi tercatat dengan alasan", async () => {
  const { collector, library } = await freshStore();
  for (const n of [1, 2]) await seed(collector, n);
  await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(1), decision(2)], removals: [] }]), library });
  const glm = fakeGlm([{
    removals: [{ sticker_id: id(1), reason: "trennya udah lewat" }],
    revisions: [{ sticker_id: id(2), label: "ketawa canggung", moods: ["laugh", "confused"], when_to_use: "saat suasana awkward", planned_frequency: "kadang", reason: "labelnya kurang pas" }],
  }]);
  const summary = await curator.runWeeklyReview({ glm, library });
  assert.match(glm.calls[0].messages[1].content, /manusia 30 hari/);
  assert.deepEqual(summary.removed.map((r) => r.id), [id(1)]);
  assert.deepEqual(summary.revised.map((r) => r.label), ["ketawa canggung"]);
  const [remaining] = await library.listCollection();
  assert.equal(remaining.label, "ketawa canggung");
  assert.equal(remaining.plannedFrequency, "kadang");
  const kinds = (await library.recentDecisions(5)).map((d) => `${d.kind}:${d.source}`);
  assert.ok(kinds.includes("remove:review") && kinds.includes("revise:review"));
});

test("penjadwal: kurasi tidak langsung jalan saat pertama kali, lalu jalan di jam tenang hari berikutnya atau setelah 36 jam", async () => {
  await withEnv({ AI_AGENT_QUIET_START: "22", AI_AGENT_QUIET_END: "7" }, async () => {
    const { collector, library } = await freshStore();
    await seed(collector, 1);
    const glm = fakeGlm([{ decisions: [decision(1)], removals: [] }]);
    const humanize = require("../ai/humanize");
    const noon = humanize.witEpochAt(12, 0);
    assert.deepEqual(await curator.maybeRunScheduled({ at: noon, library, glm }), {});
    assert.equal(glm.calls.length, 0);
    const nightNextDay = humanize.witEpochAt(23, 0, noon + DAY);
    const result = await curator.maybeRunScheduled({ at: nightNextDay, library, glm });
    assert.equal(result.curation.kept.length, 1);
    assert.deepEqual(await curator.maybeRunScheduled({ at: nightNextDay + 30 * 60_000, library, glm }), {}, "sekali per hari");
    const review = await curator.maybeRunScheduled({ at: noon + 8 * DAY, library, glm: fakeGlm([{ removals: [], revisions: [] }]) });
    assert.ok(review.review, "review mingguan jalan setelah 7 hari");
  });
});

test("pratinjau stiker animasi memakai 3 frame dalam satu strip PNG", async () => {
  const frames = await Promise.all([10, 120, 240].map((r) => sharp({ create: { width: 32, height: 32, channels: 4, background: { r, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()));
  const animated = await sharp(frames, { join: { animated: true } }).webp().toBuffer();
  const preview = await curator.stickerPreview(animated);
  assert.equal(preview.frames, 3);
  const meta = await sharp(Buffer.from(preview.dataUrl.split(",")[1], "base64")).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [480, 160, "png"]);
});

// ---------- scope & rem ----------

test("scope lokal hanya di chat asal; rem: tidak berturut-turut, jeda frekuensi, kuota per jam", async () => {
  await withEnv({ STICKER_MAX_PER_HOUR: "2" }, async () => {
    const { collector, library } = await freshStore();
    await seed(collector, 1, { chat: GROUP_A });
    await seed(collector, 2, { chat: GROUP_A });
    await seed(collector, 3, { chat: GROUP_A });
    await curator.runCuration({
      glm: fakeGlm([{ decisions: [decision(1, { scope: "local", label: "muka Budi" }), decision(2), decision(3, { planned_frequency: "jarang" })], removals: [] }]),
      library,
    });
    const now = Date.now();
    const ids = async (chat, at = now) => (await library.usableForChat(chat, { at })).map((s) => s.id).sort();
    assert.deepEqual(await ids(GROUP_A), [id(1), id(2), id(3)].sort());
    assert.deepEqual(await ids(GROUP_B), [id(2), id(3)].sort(), "stiker wajah member grup A tidak muncul di grup B");

    await library.recordBotUse(hex(2), GROUP_B, { at: now });
    assert.ok(!(await ids(GROUP_B, now + 1)).includes(id(2)), "tidak dua kali berturut-turut");
    await library.recordBotUse(hex(3), GROUP_B, { at: now + 1000 });
    assert.deepEqual(await ids(GROUP_B, now + 2000), [], "kuota 2 per jam per chat habis");
    assert.ok(!(await ids(GROUP_A, now + 2 * HOUR)).includes(id(3)), "'jarang' butuh jeda 24 jam");
    assert.ok((await ids(GROUP_A, now + 2 * HOUR)).includes(id(2)), "'sering' boleh lagi setelah 20 menit");

    const picked = await library.pickForMood("laugh", GROUP_A, { at: now + 2 * HOUR });
    assert.equal(picked.id, id(1), "deterministik: frekuensi sering dan paling lama tidak dipakai");
  });
});

// ---------- pemakaian di agent loop ----------

async function withMock(options, run) {
  const mock = await createMockOpenRouter(options).start();
  groupAgent.resetHistories();
  memoryStore.resetAllMemory();
  try {
    await run(mock);
  } finally {
    groupAgent.resetHistories();
    await mock.stop();
  }
}

function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content, options) => { sent.push({ jid, ...content, options }); return { key: { id: `bot-${sent.length}` } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

let msgCounter = 0;
const groupArgs = (sock, groupId, text, extra = {}) => ({
  sock,
  message: { key: { id: `m${++msgCounter}`, remoteJid: groupId }, message: { conversation: text } },
  groupId,
  senderId: "628222222222",
  senderName: "Budi",
  text,
  explicitMention: true,
  replyToBot: false,
  quotedText: "",
  ...extra,
});

async function seedCollection() {
  const { collector, library } = await freshStore();
  await seed(collector, 1, { chat: GROUP_A });
  await seed(collector, 2, { chat: GROUP_A });
  await curator.runCuration({
    glm: fakeGlm([{ decisions: [decision(1, { scope: "local", label: "muka Budi ngakak" }), decision(2, { label: "kucing ketawa" })], removals: [] }]),
    library,
  });
  return library;
}

test("send_sticker: GLM memilih stiker koleksi sebagai pengganti balasan; stiker lokal tidak ditawarkan di grup lain", async () => {
  const library = await seedCollection();
  await withMock({
    chat: [
      { content: null, tool_calls: [toolCall("send_sticker", { sticker_id: id(2), placement: "only" })] },
      "",
    ],
  }, async (mock) => {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(groupArgs(sock, GROUP_B, "@Grad wkwkwk kamu lucu"));
    assert.equal(result.action, "sticker");
    const request = mock.state.chat[0];
    assert.ok(request.tools.some((t) => t.function?.name === "send_sticker"));
    const prompt = JSON.stringify(request.messages);
    assert.match(prompt, new RegExp(`${id(2)} — kucing ketawa`));
    assert.doesNotMatch(prompt, new RegExp(id(1)), "stiker lokal grup A tidak ada di indeks grup B");
    assert.equal(sock.sent.length, 1);
    assert.ok(Buffer.isBuffer(sock.sent[0].sticker), "stiker dikirim sebagai file");
    assert.equal(sock.sent[0].jid, GROUP_B);
    const [kucing] = (await library.listCollection()).filter((s) => s.id === id(2));
    assert.equal(kucing.botUseCount, 1);
    assert.ok(groupAgent.getHistory(GROUP_B).some((e) => e.is_bot && e.text === "[mengirim stiker: kucing ketawa]"));
  });
});

test("'coba pake' stiker: hanya stiker yang terkirim, tanpa teks emoji tambahan", async () => {
  await seedCollection();
  const cases = [
    { placement: "only", text: "👍🤩👍", expected: ["STIKER"] },
    { placement: "only", text: "nih stikernya", expected: ["STIKER"] },
    { placement: "after_text", text: "😂😂", expected: ["STIKER"] },
    { placement: "after_text", text: "Ini dia yang barusan disimpan", expected: ["Ini dia yang barusan disimpan", "STIKER"] },
  ];
  for (const { placement, text, expected } of cases) {
    await withMock({ chat: [{ content: null, tool_calls: [toolCall("send_sticker", { sticker_id: id(2), placement })] }, text] }, async () => {
      const sock = makeSock();
      await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "@Grad coba pake"));
      assert.deepEqual(sock.sent.map((s) => s.text || (s.sticker ? "STIKER" : "?")), expected, `${placement} + "${text}"`);
    });
    // Rem "tidak berturut-turut" direset dengan koleksi baru untuk kasus berikutnya.
    await seedCollection();
  }
});

test("send_sticker menolak stiker lokal dari grup lain walau id-nya ditebak", async () => {
  await seedCollection();
  await withMock({
    chat: [
      { content: null, tool_calls: [toolCall("send_sticker", { sticker_id: id(1), placement: "after_text" })] },
      "hehe",
    ],
  }, async (mock) => {
    const sock = makeSock();
    await groupAgent.processGroupMessage(groupArgs(sock, GROUP_B, "@Grad lucu"));
    const toolResult = JSON.parse(mock.state.chat[1].messages.at(-1).content);
    assert.match(toolResult.result.error, /tidak ada di koleksi yang boleh dipakai/);
    assert.deepEqual(sock.sent.map((s) => s.text || "sticker"), ["hehe"]);
  });
});

test("reaction sesekali diganti stiker koleksi dengan mood yang cocok (tanpa panggilan GLM)", async () => {
  await seedCollection();
  await withEnv({ STICKER_REACTION_CHANCE: "1" }, () => withMock({ decision: { choice: "react_laugh", confidence: 0.95 } }, async (mock) => {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "wkwkwk", { explicitMention: false }));
    assert.equal(result.action, "sticker");
    assert.equal(result.replacedReaction, "😂");
    assert.equal(mock.state.chat.length, 0);
    assert.ok(Buffer.isBuffer(sock.sent[0].sticker));
    assert.equal(sock.sent[0].options.quoted.key.id, `m${msgCounter}`);
  }));
  await withEnv({ STICKER_REACTION_CHANCE: "0" }, () => withMock({ decision: { choice: "react_laugh", confidence: 0.95 } }, async () => {
    const sock = makeSock();
    const result = await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "wkwk", { explicitMention: false }));
    assert.equal(result.action, "react");
  }));
});

test("get_chat_media: media lama diunduh ulang dan dilampirkan ke langkah berikutnya", async () => {
  await freshStore();
  await withMock({
    chat: [
      "oke",
      { content: null, tool_calls: [toolCall("get_chat_media", { entry_id: 0 })] },
      "Di gambar itu ada grafik penjualan naik.",
    ],
  }, async (mock) => {
    const loaded = [];
    groupAgent.setMediaLoader(async (ref) => { loaded.push(ref.key.id); return { type: "image", kind: "attachment", dataUrl: "data:image/jpeg;base64,T0xE" }; });
    try {
      const sock = makeSock();
      await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "[mengirim gambar]", { media: { type: "image", dataUrl: "data:image/jpeg;base64,T0xE" } }));
      const entry = groupAgent.getHistory(GROUP_A).find((e) => e.has_image);
      entry.media = null; // simulasi media lama yang sudah dibuang dari riwayat
      mock.script.chat[0].tool_calls[0].function.arguments = JSON.stringify({ entry_id: entry.entry_id });
      await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "@Grad gambar yang tadi isinya apa?"));
      assert.deepEqual(loaded, [entry.message_ref.key.id]);
      const followUp = mock.state.chat.at(-1).messages.at(-1);
      assert.equal(followUp.role, "user");
      assert.ok(followUp.content.some((p) => p.type === "image_url" && p.image_url.url.includes("T0xE")));
      assert.equal(sock.sent.at(-1).text, "Di gambar itu ada grafik penjualan naik.");
    } finally {
      groupAgent.setMediaLoader(null);
    }
  });
});

// ---------- save_sticker: simpan atas permintaan, langsung pakai ----------

const STICKER_MEDIA = { type: "image", kind: "sticker", format: "webp", dataUrl: "data:image/webp;base64,UklGRg==" };

function replyToSticker(sock, groupId, text, n, extra = {}) {
  // Seperti index.js: stiker yang di-reply ikut terlampir sebagai media pesan itu.
  const args = groupArgs(sock, groupId, text, { media: STICKER_MEDIA, ...extra });
  args.message.message = { extendedTextMessage: { text, contextInfo: { stanzaId: "orig", quotedMessage: { stickerMessage: { fileSha256: sha(n) } } } } };
  return args;
}

test("save_sticker: 'simpan stiker ini terus kirim' → tersimpan lokal atas permintaan dan langsung terkirim", async () => {
  const { library } = await freshStore();
  const buffer = await webp({ r: 200, g: 10, b: 10, alpha: 1 });
  const downloaded = [];
  groupAgent.setStickerDownloader(async (stickerMessage) => { downloaded.push(stickerMessage.fileSha256.toString("hex").slice(0, 8)); return buffer; });
  try {
    await withMock({
      chat: [
        { content: null, tool_calls: [toolCall("save_sticker", { entry_id: 0, label: "kaget merah", moods: ["shock"], when_to_use: "saat ada kabar mengejutkan", planned_frequency: "kadang", scope: "local", safety: "ok" }, "c1")] },
        { content: null, tool_calls: [toolCall("send_sticker", { sticker_id: id(8), placement: "after_text" }, "c2")] },
        "Siap, udah kusimpan.",
      ],
    }, async (mock) => {
      const sock = makeSock();
      const args = replyToSticker(sock, GROUP_A, "@Grad simpan stiker ini terus kirim", 8);
      // entry_id pesan ini baru diketahui setelah masuk riwayat; betulkan argumen tool lewat skrip mock.
      const original = groupAgent.processGroupMessage(args);
      const entry = groupAgent.getHistory(GROUP_A).at(-1);
      mock.script.chat[0].tool_calls[0].function.arguments = JSON.stringify({ entry_id: entry.entry_id, label: "kaget merah", moods: ["shock"], when_to_use: "saat ada kabar mengejutkan", planned_frequency: "kadang", scope: "local", safety: "ok" });
      const result = await original;

      assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "save_sticker"));
      assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "send_sticker"), "send_sticker ditawarkan walau koleksi masih kosong");
      assert.deepEqual(downloaded, [id(8)], "stiker yang belum terkumpul diunduh sekali");
      assert.equal(JSON.parse(mock.state.chat[1].messages.at(-1).content).result.sticker_id, id(8));
      assert.equal(result.action, "reply");
      assert.deepEqual(sock.sent.map((s) => s.text || (s.sticker ? "STIKER" : "?")), ["Siap, udah kusimpan.", "STIKER"]);
      const [saved] = await library.listCollection();
      assert.deepEqual([saved.id, saved.label, saved.scope], [id(8), "kaget merah", "local"]);
      assert.match((await library.lastDecision(hex(8))).reason, /disimpan atas permintaan Budi/);
      assert.equal((await library.lastDecision(hex(8))).source, "request");
      assert.deepEqual((await library.usableForChat(GROUP_B)).map((s) => s.id), [], "stiker lokal permintaan tidak dipakai di grup lain");
    });
  } finally {
    groupAgent.setStickerDownloader(null);
  }
});

test("save_sticker menolak stiker tidak aman dan menjaga kapasitas", async () => {
  await withEnv({ STICKER_CAPACITY: "1" }, async () => {
    const library = await seedCollectionOf(1);
    groupAgent.setStickerDownloader(async () => webp({ r: 1, g: 2, b: 3, alpha: 1 }));
    try {
      const saver = groupAgent.makeStickerSaver({ chatId: GROUP_A, requester: "Budi", stickers: { usable: new Map(), queue: [] } });
      const sock = makeSock();
      await withMock({ decision: { choice: "ignore", confidence: 0.99 } }, async () => {
        await groupAgent.processGroupMessage(replyToSticker(sock, GROUP_A, "stiker", 9, { explicitMention: false }));
        const entryId = groupAgent.getHistory(GROUP_A).at(-1).entry_id;
        const base = { entry_id: entryId, label: "x", moods: [], when_to_use: "-", planned_frequency: "jarang", scope: "global" };

        const unsafe = await saver({ ...base, safety: "nsfw" });
        assert.match(unsafe.error, /tidak aman/);
        const full = await saver({ ...base, safety: "ok" });
        assert.match(full.error, /koleksi penuh/);
        const replaced = await saver({ ...base, safety: "ok", replace_sticker_id: id(1) });
        assert.equal(replaced.ok, true);
        assert.deepEqual((await library.listCollection()).map((s) => s.id), [id(9)]);
        assert.match((await library.lastDecision(hex(1))).reason, /diganti stiker baru atas permintaan Budi/);
      });
    } finally {
      groupAgent.setStickerDownloader(null);
    }
  });
});

async function seedCollectionOf(n) {
  const { collector, library } = await freshStore();
  await seed(collector, n, { chat: GROUP_A });
  await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(n)], removals: [] }]), library });
  return library;
}

// ---------- command owner ----------

test("/stiker lihat, buang, kurasi lewat handleMessage (owner)", async () => {
  const library = await seedCollection();
  const bot = require("../index.js");
  bot.resetData();
  bot.getData().owner = OWNER;
  bot.getData().allowedGroups = [GROUP_A];
  const collector = getStickerCollector();
  await seed(collector, 7, { chat: GROUP_A });
  await withMock({ chat: [JSON.stringify({ decisions: [decision(7, { label: "anjing kaget", moods: ["shock"] })], removals: [] })] }, async () => {
    const sock = makeSock();
    bot.setSock(sock);
    const send = (text) => bot.dispatchInboundMessage({ key: { id: `c${++msgCounter}`, remoteJid: GROUP_A, participant: `${OWNER}@s.whatsapp.net`, fromMe: false }, pushName: "Rehan", message: { conversation: text } }, { sock });

    await send(`/stiker lihat ${id(2)}`);
    assert.ok(Buffer.isBuffer(sock.sent.at(-2).sticker));
    assert.match(sock.sent.at(-1).text, /kucing ketawa/);
    assert.match(sock.sent.at(-1).text, /Alasan disimpan: sering dipakai/);

    await send(`/stiker buang ${id(2)} kebanyakan dipakai`);
    assert.match(sock.sent.at(-1).text, /dibuang dari koleksi/);
    assert.equal((await library.findSticker(id(2))).status, "removed");

    await send("/stiker kurasi");
    assert.match(sock.sent.at(-1).text, /Kurasi selesai: 1 kandidat dinilai/);
    assert.match(sock.sent.at(-1).text, /anjing kaget/);

    await send("/stiker");
    const overview = sock.sent.at(-1).text;
    assert.match(overview, /Koleksi: 2/);
    assert.match(overview, /buang "kucing ketawa" \(owner, barusan\): kebanyakan dipakai/);
  });
});

// Kasus nyata 27 Sep: "simpan semua stiker ini" untuk 8 stiker, tapi hanya 4 yang
// terlampir; GLM menyalin label ke 4 lainnya. Penjaga: stiker harus dilihat dulu.
function stickerArgs(sock, groupId, n) {
  const args = groupArgs(sock, groupId, "[mengirim stiker]", { explicitMention: false, media: STICKER_MEDIA });
  args.message.message = { stickerMessage: { fileSha256: sha(n) } };
  return args;
}

test("save_sticker menolak stiker yang belum dilihat; lolos setelah get_chat_media", async () => {
  const { library } = await freshStore();
  groupAgent.setStickerDownloader(async () => webp({ r: 9, g: 9, b: 9, alpha: 1 }));
  groupAgent.setMediaLoader(async () => STICKER_MEDIA);
  try {
    await withEnv({ AI_HISTORY_MEDIA_LIMIT: "1" }, () => withMock({ decision: { choice: "ignore", confidence: 0.99 }, chat: [] }, async (mock) => {
      const sock = makeSock();
      await groupAgent.processGroupMessage(stickerArgs(sock, GROUP_A, 21));
      await groupAgent.processGroupMessage(stickerArgs(sock, GROUP_A, 22));
      const [older, newer] = groupAgent.getHistory(GROUP_A).map((item) => item.entry_id);
      const save = (entryId, label, callId) => toolCall("save_sticker", { entry_id: entryId, label, moods: ["laugh"], when_to_use: "-", planned_frequency: "kadang", scope: "global", safety: "ok" }, callId);
      mock.script.decision = { choice: "reply", confidence: 0.95 };
      mock.script.chat = [
        { content: null, tool_calls: [save(newer, "baru", "c1"), save(older, "tebakan", "c2"), toolCall("get_chat_media", { entry_id: older }, "c3")] },
        { content: null, tool_calls: [save(older, "lama", "c4")] },
        "Dua-duanya udah kusimpan.",
      ];
      await groupAgent.processGroupMessage(groupArgs(sock, GROUP_A, "@Grad simpan semua stiker ini"));

      const prompt = JSON.stringify(mock.state.chat[0].messages);
      assert.match(prompt, new RegExp(`Media lama dari #${newer} `), "media lama berlabel #id");
      const results = mock.state.chat[1].messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).result);
      assert.equal(results[0].ok, true, "stiker yang terlampir boleh langsung disimpan");
      assert.match(results[1].error, /belum melihat stiker/);
      const later = JSON.parse(mock.state.chat[2].messages.at(-1).content).result;
      assert.equal(later.ok, true, "setelah gambarnya masuk, boleh disimpan");
      assert.deepEqual((await library.listCollection()).map((s) => s.label).sort(), ["baru", "lama"]);
    }));
  } finally {
    groupAgent.setStickerDownloader(null);
    groupAgent.setMediaLoader(null);
  }
});

test("remove_sticker: hanya pengelola, 'hapus semua' membuang yang terlihat di chat ini saja", async () => {
  const library = await seedCollection(); // #1 lokal GROUP_A, #2 global
  const checks = [];
  let allowed = false;
  groupAgent.setStickerManagerCheck(async (who) => { checks.push(who); return allowed; });
  try {
    await withMock({ chat: [{ content: null, tool_calls: [toolCall("remove_sticker", { all: true })] }, "Maaf, cuma admin yang bisa."] }, async (mock) => {
      const sock = makeSock();
      await groupAgent.processGroupMessage(groupArgs(sock, GROUP_B, "@Grad hapus semua koleksimu"));
      assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "remove_sticker"));
      assert.match(JSON.stringify(mock.state.chat[0].messages[0]), /remove_sticker/);
      assert.match(JSON.parse(mock.state.chat[1].messages.at(-1).content).result.error, /hanya owner, admin grup/);
      assert.deepEqual(checks.at(-1), { chatId: GROUP_B, senderId: "628222222222", isDm: false });
      assert.equal((await library.listCollection()).length, 2, "ditolak = tidak ada yang dibuang");
    });

    allowed = true;
    // Baru dipakai = kena rem jeda dan hilang dari daftar pakai, tapi tetap harus bisa dibuang.
    await library.recordBotUse(hex(2), GROUP_B);
    assert.deepEqual((await library.usableForChat(GROUP_B)).map((s) => s.id), []);
    await withMock({ chat: [{ content: null, tool_calls: [toolCall("remove_sticker", { all: true, reason: "bosen" })] }, "Udah kubuang."] }, async (mock) => {
      await groupAgent.processGroupMessage(groupArgs(makeSock(), GROUP_B, "@Grad hapus semua koleksimu"));
      const result = JSON.parse(mock.state.chat[1].messages.at(-1).content).result;
      assert.deepEqual(result.removed.map((r) => r.sticker_id), [id(2)], "stiker lokal grup lain tidak ikut terbuang");
      assert.deepEqual((await library.listCollection()).map((s) => s.id), [id(1)]);
      const last = await library.lastDecision(hex(2));
      assert.equal(last.source, "request");
      assert.match(last.reason, /dibuang atas permintaan Budi: bosen/);
    });

    await withMock({ chat: [{ content: null, tool_calls: [toolCall("remove_sticker", { sticker_ids: [id(1), "ffffffff"] })] }, "Oke."] }, async (mock) => {
      await groupAgent.processGroupMessage(groupArgs(makeSock(), GROUP_A, "@Grad buang stiker muka Budi"));
      const result = JSON.parse(mock.state.chat[1].messages.at(-1).content).result;
      assert.deepEqual([result.removed.map((r) => r.sticker_id), result.not_found], [[id(1)], ["ffffffff"]]);
      assert.equal((await library.listCollection()).length, 0);
    });
  } finally {
    groupAgent.setStickerManagerCheck(null);
  }
});

test("statistik /stiker menghitung pemakaian stiker yang sudah masuk koleksi", async () => {
  const { collector, library } = await freshStore();
  await seed(collector, 1, { uses: 2 });
  await seed(collector, 2, { uses: 1 });
  await curator.runCuration({ glm: fakeGlm([{ decisions: [decision(1), decision(2, { decision: "skip" })], removals: [] }]), library });
  const stats = await collector.stats();
  assert.equal(stats.uses, 3);
  assert.deepEqual(stats.top.map((t) => t.sha), [], "yang sudah diputuskan tidak tampil sebagai kandidat");
});
