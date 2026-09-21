const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const agent = require("../ai/group-agent");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeMockAiServer(hangFirstDecision = true) {
  const state = { decisions: [], chatCalls: [] };
  const mock = {
    state,
    decision: { choice: "reply", confidence: 0.9 },
    gratitude: { choice: "not_gratitude", confidence: 0.99 },
    reply: "Oke, aku jawab ya.",
  };
  let releaseFirstDecision;
  const firstDecisionGate = new Promise((resolve) => { releaseFirstDecision = resolve; });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      if (req.url === "/api/alpha/decisions") {
        state.decisions.push(JSON.parse(body || "{}"));
        if (hangFirstDecision && state.decisions.length === 1) await firstDecisionGate;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          answers: {
            action: mock.decision,
            gratitude_target: mock.gratitude,
          },
        }));
        return;
      }
      if (req.url === "/api/v1/chat/completions") {
        state.chatCalls.push(JSON.parse(body || "{}"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: mock.reply } }] }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const listen = () =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return {
    state,
    releaseFirstDecision,
    setDecision: (decision) => { mock.decision = decision; },
    setReply: (reply) => { mock.reply = reply; },
    listen,
    close,
  };
}

function makeAiSock() {
  const sent = [];
  const reads = [];
  return {
    sent,
    reads,
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, ...content, options });
      return { key: { id: `sent-${sent.length}` } };
    },
    readMessages: async (keys) => reads.push(...keys.map((k) => k.id)),
    sendPresenceUpdate: async () => {},
  };
}

function aiMessage(id) {
  return { key: { id, remoteJid: "queue@g.us" } };
}

async function withMockAiServer(runTest, hangFirstDecision = true) {
  const mock = makeMockAiServer(hangFirstDecision);
  const oldEnv = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    AI_DEBOUNCE_MS: process.env.AI_DEBOUNCE_MS,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  };
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_DEBOUNCE_MS = "50";
  process.env.OPENROUTER_BASE_URL = await mock.listen();
  agent.resetHistories();
  try {
    await runTest(mock);
  } finally {
    agent.resetHistories();
    await mock.close();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("choiceConfidence memakai confidence atau probabilitas pilihan", () => {
  assert.equal(agent.choiceConfidence({ choice: "reply", confidence: 0.91 }), 0.91);
  assert.equal(agent.choiceConfidence({ choice: "reply", probabilities: { reply: 0.83 } }), 0.83);
  assert.equal(agent.choiceConfidence(null), 0);
});

test("cleanReply membuang code fence dan membatasi panjang bubble", () => {
  assert.equal(agent.cleanReply("```\nHalo!\n```", 100), "Halo!");
  assert.equal(agent.cleanReply("1234567890", 6), "12345…");
});

test("parseGeneratedReply menerima JSON biasa dan JSON code fence", () => {
  assert.deepEqual(
    agent.parseGeneratedReply('{"text":"halo","reply_to_entry_id":12}', 100),
    { text: "halo", replyToEntryId: 12 },
  );
  assert.deepEqual(
    agent.parseGeneratedReply('```json\n{"text":"standalone","reply_to_entry_id":null}\n```', 100),
    { text: "standalone", replyToEntryId: null },
  );
});

test("riwayat grup terpisah dan dibatasi", () => {
  const oldLimit = process.env.AI_HISTORY_LIMIT;
  process.env.AI_HISTORY_LIMIT = "3";
  agent.resetHistories();

  agent.remember("grup-a", { sender: "A", text: "satu" });
  agent.remember("grup-a", { sender: "B", text: "dua" });
  agent.remember("grup-a", { sender: "C", text: "tiga" });
  agent.remember("grup-a", { sender: "D", text: "empat" });
  agent.remember("grup-b", { sender: "E", text: "sendiri" });

  assert.deepEqual(agent.getHistory("grup-a").map((x) => x.text), ["dua", "tiga", "empat"]);
  assert.deepEqual(agent.getHistory("grup-b").map((x) => x.text), ["sendiri"]);

  if (oldLimit === undefined) delete process.env.AI_HISTORY_LIMIT;
  else process.env.AI_HISTORY_LIMIT = oldLimit;
  agent.resetHistories();
});

test("batas compact selalu konsisten dengan kapasitas riwayat", () => {
  const previous = {
    AI_HISTORY_LIMIT: process.env.AI_HISTORY_LIMIT,
    AI_COMPACT_TRIGGER: process.env.AI_COMPACT_TRIGGER,
    AI_COMPACT_RETAIN: process.env.AI_COMPACT_RETAIN,
  };
  process.env.AI_HISTORY_LIMIT = "8";
  process.env.AI_COMPACT_TRIGGER = "18";
  process.env.AI_COMPACT_RETAIN = "99";

  const current = agent.config();
  assert.equal(current.historyLimit, 8);
  assert.equal(current.compactTrigger, 8);
  assert.equal(current.compactRetain, 7);

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("prompt GLM meminta gaya singkat tanpa Markdown", () => {
  agent.resetHistories();
  agent.remember("grup", { sender: "Budi", text: "Server masih 502" });
  const messages = agent.buildChatMessages({
    groupId: "grup",
    latestMessage: { sender: "Ani", text: "Terus cek apa?" },
    quotedText: "Server masih 502",
  });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Jangan gunakan Markdown/);
  assert.match(messages[1].content, /Budi \[nomor-tidak-diketahui\]: Server masih 502/);
  assert.match(messages[1].content, /Ani: Terus cek apa/);
});

test("nama bot di teks dianggap mention dengan batas kata", () => {
  assert.equal(agent.textMentionsBotName("Grad, bantu dong", "Grad"), true);
  assert.equal(agent.textMentionsBotName("@grad kenapa langit biru?", "Grad"), true);
  assert.equal(agent.textMentionsBotName("gradient warnanya bagus", "Grad"), false);
  assert.equal(agent.textMentionsBotName("Makasih Budi", "Grad"), false);
});

test("buildChatMessages melampirkan gambar/video sebagai konten multimodal", () => {
  agent.resetHistories();
  const withImage = agent.buildChatMessages({
    groupId: "img",
    latestMessage: { sender: "Ani", text: "lihat nih" },
    quotedText: "",
    media: { type: "image", dataUrl: "data:image/jpeg;base64,QUJD" },
  });
  assert.ok(Array.isArray(withImage[1].content), "konten harus multipart saat ada gambar");
  assert.equal(withImage[1].content[1].type, "image_url");
  assert.equal(withImage[1].content[1].image_url.url, "data:image/jpeg;base64,QUJD");

  const withVideo = agent.buildChatMessages({
    groupId: "vid",
    latestMessage: { sender: "Ani", text: "tengok ini" },
    quotedText: "",
    media: { type: "video", dataUrl: "data:video/mp4;base64,QUJD" },
  });
  assert.ok(Array.isArray(withVideo[1].content), "konten harus multipart saat ada video");
  assert.equal(withVideo[1].content[1].type, "video_url");
  assert.equal(withVideo[1].content[1].video_url.url, "data:video/mp4;base64,QUJD");

  const plain = agent.buildChatMessages({
    groupId: "img",
    latestMessage: { sender: "Ani", text: "halo" },
    quotedText: "",
    media: { type: "image", dataUrl: "bukan-data-url" },
  });
  assert.equal(typeof plain[1].content, "string", "data URL tidak valid harus diabaikan");
});

test("media dari percakapan aktif lama ikut dilampirkan ke GLM", () => {
  agent.resetHistories();
  agent.remember("history-media", {
    sender: "Ani",
    senderId: "+6281111",
    text: "ini gambar errornya",
    hasImage: true,
    media: { type: "image", dataUrl: "data:image/jpeg;base64,TEFNQQ==" },
  });

  const messages = agent.buildChatMessages({
    groupId: "history-media",
    latestMessage: { sender: "Budi", sender_id: "+6282222", text: "menurutmu kenapa?" },
    quotedText: "",
  });
  assert.ok(Array.isArray(messages[1].content));
  assert.ok(messages[1].content.some((part) => part.type === "image_url" && part.image_url.url.includes("TEFNQQ==")));
  assert.ok(messages[1].content.some((part) => part.type === "text" && /Media lama dari Ani/.test(part.text)));
});

test("jumlah media aktif yang disimpan mengikuti AI_HISTORY_MEDIA_LIMIT", () => {
  const previous = process.env.AI_HISTORY_MEDIA_LIMIT;
  process.env.AI_HISTORY_MEDIA_LIMIT = "2";
  agent.resetHistories();
  for (let index = 1; index <= 3; index++) {
    agent.remember("media-limit", {
      sender: "Ani",
      text: `gambar ${index}`,
      hasImage: true,
      media: { type: "image", dataUrl: `data:image/jpeg;base64,${index}` },
    });
  }
  assert.equal(agent.getHistory("media-limit").filter((item) => item.media).length, 2);
  assert.equal(agent.getHistory("media-limit")[0].has_image, true, "penanda media lama tetap dipertahankan");
  if (previous === undefined) delete process.env.AI_HISTORY_MEDIA_LIMIT;
  else process.env.AI_HISTORY_MEDIA_LIMIT = previous;
  agent.resetHistories();
});

test("processGroupMessage mengirim media ke GLM dan sinyal ke Jev", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("img1"),
      groupId: "image@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "lihat nih",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
      media: { type: "image", dataUrl: "data:image/jpeg;base64,QUJD" },
    });

    assert.equal(result.action, "reply");
    const decisionState = mock.state.decisions[0].state.signals;
    assert.equal(decisionState.has_image, true);
    assert.equal(decisionState.has_video, false);
    assert.equal(
      agent.getHistory("image@g.us").find((entry) => entry.sender === "Ani").has_image,
      true,
      "pesan manusia dengan gambar harus tercatat has_image",
    );
    const content = mock.state.chatCalls[0].messages.at(-1).content;
    assert.ok(Array.isArray(content), "request GLM harus membawa gambar");
    assert.equal(content[1].type, "image_url");
  }, false);
});

test("processGroupMessage mengirim video_url ke GLM", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("vid1"),
      groupId: "video@g.us",
      senderId: "+6281111",
      senderName: "Budi",
      text: "[mengirim video]",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
      media: { type: "video", dataUrl: "data:video/mp4;base64,QUJD" },
    });

    assert.equal(result.action, "reply");
    const decisionState = mock.state.decisions[0].state.signals;
    assert.equal(decisionState.has_video, true);
    const content = mock.state.chatCalls[0].messages.at(-1).content;
    assert.ok(Array.isArray(content), "request GLM harus membawa video");
    assert.equal(content[1].type, "video_url");
  }, false);
});

test("Jev menerima perbedaan stiker, GIF, dan lampiran", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    await agent.processGroupMessage({
      sock,
      message: aiMessage("sticker-kind"),
      groupId: "sticker-kind@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "[mengirim stiker]",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
      media: { type: "video", kind: "sticker", format: "gif", dataUrl: "data:video/mp4;base64,QUJD" },
    });
    const signals = mock.state.decisions[0].state.signals;
    assert.equal(signals.media_kind, "sticker");
    assert.equal(signals.media_format, "gif");
    assert.equal(signals.is_sticker, true);
    assert.equal(signals.is_attachment, false);
    assert.equal(signals.is_gif, true);
  }, false);
});

test("GLM dapat memilih pesan lama untuk di-reply atau mengirim standalone", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    mock.setReply(JSON.stringify({ text: "Jawaban pertama", reply_to_entry_id: null }));
    await agent.processGroupMessage({
      sock,
      message: aiMessage("select-1"),
      groupId: "select-reply@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan awal",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
    });
    const target = agent.getHistory("select-reply@g.us").find((item) => item.text === "pertanyaan awal");
    assert.equal(sock.sent[0].options, undefined, "null harus dikirim tanpa quote");

    mock.setReply(JSON.stringify({ text: "Aku jawab yang awal", reply_to_entry_id: target.entry_id }));
    const secondMessage = { key: { id: "select-2", remoteJid: "select-reply@g.us" }, message: { conversation: "lanjut" } };
    await agent.processGroupMessage({
      sock,
      message: secondMessage,
      groupId: "select-reply@g.us",
      senderId: "+6282222",
      senderName: "Budi",
      text: "lanjut",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
    });
    assert.equal(sock.sent[1].options.quoted.key.id, "select-1");
  }, false);
});

test("processGroupMessage mengirim ulang gambar lama saat membalas pesan berikutnya", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    await agent.processGroupMessage({
      sock,
      message: aiMessage("old-img"),
      groupId: "old-image@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "lihat error ini",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
      media: { type: "image", dataUrl: "data:image/jpeg;base64,R0FNQkFS" },
    });
    await agent.processGroupMessage({
      sock,
      message: aiMessage("followup-img"),
      groupId: "old-image@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "jadi penyebabnya apa?",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
    });

    const followupContent = mock.state.chatCalls[1].messages.at(-1).content;
    assert.ok(Array.isArray(followupContent));
    assert.ok(followupContent.some((part) => part.type === "image_url" && part.image_url.url.includes("R0FNQkFS")));
  }, false);
});

test("read receipt dan status mengetik memakai API Baileys", async () => {
  const calls = [];
  const sock = {
    readMessages: async (keys) => calls.push(["read", keys]),
    sendPresenceUpdate: async (state, jid) => calls.push([state, jid]),
  };
  const message = { key: { remoteJid: "grup@g.us", id: "pesan-1" } };

  await agent.markRead(sock, message);
  await agent.setTyping(sock, "grup@g.us", "composing");
  await agent.setTyping(sock, "grup@g.us", "paused");

  assert.deepEqual(calls, [
    ["read", [message.key]],
    ["composing", "grup@g.us"],
    ["paused", "grup@g.us"],
  ]);
});

test("prompt membedakan identitas berdasarkan nomor, bukan nama saja", () => {
  agent.resetHistories();
  agent.remember("identitas", { sender: "Rian", senderId: "+628511111111", text: "Pesan pertama" });
  agent.remember("identitas", { sender: "Rian", senderId: "+628522222222", text: "Pesan orang lain" });
  const messages = agent.buildChatMessages({
    groupId: "identitas",
    latestMessage: { sender: "Rian", sender_id: "+628522222222", text: "Pesan orang lain" },
    quotedText: "",
  });
  assert.match(messages[1].content, /Rian \[\+628511111111\]/);
  assert.match(messages[1].content, /Rian \[\+628522222222\]/);
});

test("processGroupMessage menyimpan senderId dari argumen tanpa ReferenceError", async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  process.env.OPENROUTER_API_KEY = "test-key-tidak-dikirim";
  process.env.AI_DEBOUNCE_MS = "60000";
  agent.resetHistories();

  const pending = agent.processGroupMessage({
    sock: {},
    message: { key: { id: "runtime-1", remoteJid: "runtime@g.us" } },
    groupId: "runtime@g.us",
    senderId: "+6285212345678 (085212345678)",
    senderName: "Rehan",
    text: "Grad",
    explicitMention: true,
    replyToBot: false,
    quotedText: "",
  });

  assert.equal(agent.getHistory("runtime@g.us")[0].sender_id, "+6285212345678 (085212345678)");
  agent.resetHistories();
  assert.equal((await pending).action, "superseded");

  if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = oldKey;
  if (oldDebounce === undefined) delete process.env.AI_DEBOUNCE_MS;
  else process.env.AI_DEBOUNCE_MS = oldDebounce;
});

test("pesan saat evaluasi berjalan mengantri dan tetap diproses, tidak dibatalkan", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const p1 = agent.processGroupMessage({
      sock,
      message: aiMessage("m1"),
      groupId: "queue@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan satu",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150); // debounce selesai, evaluasi m1 sedang berjalan (menunggu Jev)
    const p2 = agent.processGroupMessage({
      sock,
      message: aiMessage("m2"),
      groupId: "queue@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan dua",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150); // evaluasi m2 masuk antrian di belakang m1
    mock.releaseFirstDecision();

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.action, "reply", "evaluasi yang berjalan tidak boleh dibatalkan pesan baru");
    assert.equal(r2.action, "reply", "pesan baru harus diproses setelah antrian");
    assert.equal(sock.sent.length, 2);
    assert.deepEqual(
      [...sock.reads].sort(),
      ["m1", "m2"],
      "read receipt dikirim saat Jev merespons tiap pesan",
    );
    assert.equal(mock.state.decisions.length, 2);
    const firstReplyContent = mock.state.chatCalls[0].messages.at(-1).content;
    const firstReplyText = Array.isArray(firstReplyContent)
      ? firstReplyContent.find((part) => part.type === "text")?.text || ""
      : firstReplyContent;
    assert.doesNotMatch(
      firstReplyText,
      /pertanyaan dua/,
      "GLM untuk pesan pertama tidak boleh melihat pesan yang datang setelah evaluasi dimulai",
    );
  });
});

test("clear membatalkan evaluasi aktif dan antrean lama", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const groupId = "clear-race@g.us";
    const p1 = agent.processGroupMessage({
      sock,
      message: aiMessage("clear-1"),
      groupId,
      senderId: "+6281111",
      senderName: "Ani",
      text: "pesan lama satu",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150);
    const p2 = agent.processGroupMessage({
      sock,
      message: aiMessage("clear-2"),
      groupId,
      senderId: "+6282222",
      senderName: "Budi",
      text: "pesan lama dua",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150);

    agent.clearConversation(groupId);
    mock.releaseFirstDecision();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.action, "superseded");
    assert.equal(r2.action, "superseded");
    assert.equal(sock.sent.length, 0, "evaluasi dari konteks sebelum clear tidak boleh membalas");
    assert.equal(mock.state.chatCalls.length, 0, "GLM tidak boleh dijalankan untuk konteks yang sudah dihapus");
  });
});

test("lanjutan percakapan dengan bot dijawab meski confidence Jev rendah", async () => {
  await withMockAiServer(async (mock) => {
    mock.setDecision({ choice: "reply", confidence: 0.4 }); // di bawah replyConfidence 0.55
    const sock = makeAiSock();
    agent.remember("dialog@g.us", { sender: "Grad", senderId: "BOT", text: "Hai Rehan, ada apa?", isBot: true });

    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("d1"),
      groupId: "dialog@g.us",
      senderId: "+6281111",
      senderName: "Rehan",
      text: "Mau lihat ga art baru ku?",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    assert.equal(result.action, "reply", "pesan lanjutan dialog bot harus dijawab walau confidence rendah");
    assert.equal(sock.sent.length, 1);
  }, false);
});

test("percakapan antarmanusia tetap diabaikan walau confidence rendah", async () => {
  await withMockAiServer(async (mock) => {
    mock.setDecision({ choice: "reply", confidence: 0.4 });
    const sock = makeAiSock();
    agent.remember("human@g.us", { sender: "Andi", senderId: "+628333", text: "Nanti makan di mana?" });

    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("h1"),
      groupId: "human@g.us",
      senderId: "+628444",
      senderName: "Sari",
      text: "Di warung depan saja.",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    assert.equal(result.action, "ignore", "confidence rendah tanpa konteks bot harus tetap diam");
    assert.equal(sock.sent.length, 0);
  }, false);
});

test("konfirmasi singkat dalam dialog bot tetap dapat reaction ack", async () => {
  await withMockAiServer(async (mock) => {
    mock.setDecision({ choice: "react_ack", confidence: 0.8 });
    mock.gratitude = { choice: "not_gratitude", confidence: 0.9 };
    const sock = makeAiSock();
    agent.remember("ack@g.us", { sender: "Grad", senderId: "BOT", text: "Bagus tuh, karya mu sendiri?", isBot: true });

    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("a1"),
      groupId: "ack@g.us",
      senderId: "+6281111",
      senderName: "Rehan",
      text: "iyap",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    assert.equal(result.action, "react", "konfirmasi ke bot harus dapat reaction, bukan diabaikan");
    assert.equal(result.emoji, "👍");
  }, false);
});

test("reaction heart untuk orang lain tidak dicuri bot", async () => {
  await withMockAiServer(async (mock) => {
    mock.setDecision({ choice: "react_heart", confidence: 0.9 });
    mock.gratitude = { choice: "other_person", confidence: 0.9 };
    const sock = makeAiSock();
    agent.remember("heart@g.us", { sender: "Grad", senderId: "BOT", text: "Semangat ya!", isBot: true });

    const result = await agent.processGroupMessage({
      sock,
      message: aiMessage("h1"),
      groupId: "heart@g.us",
      senderId: "+6281111",
      senderName: "Rehan",
      text: "Makasih Budi sayang",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    assert.equal(result.action, "ignore", "apresiasi untuk orang lain tidak boleh direact bot");
    assert.equal(sock.sent.length, 0);
  }, false);
});

test("pesan dalam jendela debounce yang sama digabung (superseded)", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const p1 = agent.processGroupMessage({
      sock,
      message: aiMessage("m1"),
      groupId: "burst@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "satu",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    const p2 = agent.processGroupMessage({
      sock,
      message: aiMessage("m2"),
      groupId: "burst@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "dua",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.action, "superseded");
    assert.equal(r2.action, "reply");
    assert.equal(sock.sent.length, 1);
    assert.deepEqual(sock.reads, ["m2"]);
    assert.equal(mock.state.decisions.length, 1);
  }, false);
});

test("evaluasi antrean yang basi (ada pesan lebih baru) dilewati", async () => {
  await withMockAiServer(async (mock) => {
    const sock = makeAiSock();
    const p1 = agent.processGroupMessage({
      sock,
      message: aiMessage("m1"),
      groupId: "stale@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan satu",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150); // evaluasi m1 sedang berjalan
    const p2 = agent.processGroupMessage({
      sock,
      message: aiMessage("m2"),
      groupId: "stale@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan dua",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(150); // evaluasi m2 masuk antrian
    const p3 = agent.processGroupMessage({
      sock,
      message: aiMessage("m3"),
      groupId: "stale@g.us",
      senderId: "+6281111",
      senderName: "Ani",
      text: "pertanyaan tiga",
      explicitMention: false,
      replyToBot: false,
      quotedText: "",
    });
    await sleep(20); // m3 masih dalam jendela debounce
    mock.releaseFirstDecision();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.action, "reply");
    assert.equal(r2.action, "superseded", "evaluasi basi dilewati, pesan terbaru mewakili");
    assert.equal(r3.action, "reply");
    assert.equal(sock.sent.length, 2);
    assert.deepEqual(
      [...sock.reads].sort(),
      ["m1", "m3"],
      "pesan basi tidak ditandai terbaca karena Jev tidak meresponsnya",
    );
    assert.equal(mock.state.decisions.length, 2);
  });
});
