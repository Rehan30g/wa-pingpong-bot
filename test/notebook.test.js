const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-notebook-");
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const notebook = require("../ai/memory/notebook");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");

test.after(() => cleanup());

const GROUP = "120363888000111@g.us";
const DM = "628111222333@s.whatsapp.net";
const REHAN = { phone: "628111222333", name: "Rehan" };

function fresh() {
  try { fs.unlinkSync(process.env.NOTEBOOK_FILE); } catch {}
  notebook.resetCache();
}

test("remember/recall/forget: tentang pengirim, grup, atau peserta; dedupe; tersimpan di file", () => {
  fresh();
  const book = notebook.forChat({ chatId: GROUP, sender: REHAN, resolvePerson: (name) => (name.toLowerCase() === "budi" ? { phone: "628444", name: "Budi" } : null) });
  const allergy = book.remember({ fact: "alergi udang", about: "aku" });
  assert.equal(allergy.about, "Rehan");
  assert.equal(book.remember({ fact: "Alergi udang", about: "pengirim" }).note, "sudah diingat sebelumnya");
  book.remember({ fact: "suka kopi susu tanpa gula", about: "Budi" });
  book.remember({ fact: "rapat mingguan tiap Jumat jam 10", about: "grup" });

  const found = book.recall({ query: "makanan udang" });
  assert.deepEqual(found.facts.map((f) => f.fact), ["alergi udang"]);
  assert.equal(book.recall({ query: "kopi" }).facts[0].about, "Budi");

  notebook.resetCache();
  const reloaded = notebook.forChat({ chatId: GROUP, sender: REHAN });
  assert.equal(reloaded.recall({ query: "rapat" }).facts.length, 1, "bertahan setelah dibaca ulang dari file");
  assert.equal(reloaded.forget({ id: allergy.id }).ok, true);
  assert.deepEqual(reloaded.recall({ query: "udang" }).facts, []);
});

test("scope: fakta di DM tidak terlihat di grup dan sebaliknya; recall juga mencari memori compact", () => {
  fresh();
  notebook.forChat({ chatId: DM, sender: REHAN }).remember({ fact: "lagi sakit gigi" });
  const group = notebook.forChat({ chatId: GROUP, sender: REHAN, groupMemory: () => "Rehan memakai Blender 3D. Kevin ingat karakter Shikara yang kalem." });
  assert.deepEqual(group.recall({ query: "sakit gigi" }).facts, []);
  assert.deepEqual(group.recall({ query: "Shikara" }).from_compact_memory, ["Kevin ingat karakter Shikara yang kalem."]);
  assert.match(group.promptFacts().join("\n") || "kosong", /kosong/);
});

test("catatan: tulis, tambah, baca dengan judul perkiraan, daftar", () => {
  fresh();
  const book = notebook.forChat({ chatId: GROUP, sender: REHAN });
  book.noteWrite({ title: "Keputusan rapat 26 Sep", content: "• Demo Grad Minggu\n• Budi bawa proyektor" });
  book.noteWrite({ title: "keputusan rapat 26 sep", content: "• Kevin siapkan slide", mode: "append" });
  const read = book.noteRead({ title: "rapat kemarin" });
  assert.equal(read.title, "Keputusan rapat 26 Sep");
  assert.match(read.content, /Budi bawa proyektor\n• Kevin siapkan slide/);
  assert.equal(book.noteList().notes.length, 1);
  assert.match(notebook.forChat({ chatId: DM }).noteRead({ title: "rapat" }).error, /tidak ditemukan/, "catatan grup tidak ada di DM");
});

test("agent loop: fakta masuk konteks prompt, remember lewat tool menyimpan atas nama pengirim, memori mati = tools tidak ada", async () => {
  fresh();
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("remember", { fact: "alergi udang", about: "pengirim" })] },
      "Oke, aku inget kamu alergi udang.",
      "Coba nasi goreng ayam atau sate ayam, aman tanpa udang.",
    ],
  }).start();
  try {
    const sock = { sendMessage: async () => ({ key: { id: "b" } }), readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const args = (id, text) => ({ sock, message: { key: { id, remoteJid: GROUP } }, groupId: GROUP, senderId: REHAN.phone, senderName: REHAN.name, text, explicitMention: true, replyToBot: false, quotedText: "" });
    await groupAgent.processGroupMessage(args("n1", "@Grad inget ya aku alergi udang"));
    assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "remember"));
    await groupAgent.processGroupMessage(args("n2", "@Grad rekomendasiin makanan buat aku"));
    const prompt = JSON.stringify(mock.state.chat.at(-1).messages);
    assert.match(prompt, /Hal yang kamu ingat di chat ini/);
    assert.match(prompt, /tentang Rehan: alergi udang/);

    features.setGroupFeature(GROUP, "memori", false, { role: "admin" });
    await groupAgent.processGroupMessage(args("n3", "@Grad inget ini ya"));
    const last = mock.state.chat.at(-1);
    assert.ok(!(last.tools || []).some((t) => ["remember", "recall", "note_write"].includes(t.function?.name)));
    assert.doesNotMatch(JSON.stringify(last.messages), /Hal yang kamu ingat/);
  } finally {
    await mock.stop();
  }
});
