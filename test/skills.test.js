const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-skills-");
process.env.SKILLS_DIR = path.join(testDir, "skills");
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const skills = require("../ai/skills");
const tools = require("../ai/agent/tools");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");

test.after(() => cleanup());

const CHAT = "120363123000777@g.us";

test("skill bawaan valid, difilter fitur, dan skill owner menimpa bawaan", () => {
  skills.resetCache();
  const names = skills.allSkills().map((s) => s.name);
  for (const name of ["qr_code", "grafik_data", "kurs_mata_uang", "cuaca", "jadwal_sholat", "hitung_keuangan", "patungan", "riset_perbandingan", "ringkas_link", "notulen_rapat", "stiker_kustom"]) {
    assert.ok(names.includes(name), `skill ${name} ada`);
  }
  for (const skill of skills.allSkills()) {
    assert.ok(skill.requires.every((f) => features.isFeature(f)), `${skill.name}: fitur requires dikenal`);
    assert.ok(skill.description.length < 200 && skill.body.length > 100);
  }
  const noPython = skills.skillsFor(new Set(["web", "memori"])).map((s) => s.name);
  assert.ok(noPython.includes("ringkas_link") && !noPython.includes("qr_code"), "skill python tersembunyi saat python mati");

  fs.mkdirSync(process.env.SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.SKILLS_DIR, "cuaca.md"), "---\nname: cuaca\ndescription: versi owner\n---\nLangkah owner yang panjangnya cukup untuk dianggap valid oleh parser skill.");
  fs.writeFileSync(path.join(process.env.SKILLS_DIR, "rusak.md"), "tanpa frontmatter");
  skills.resetCache();
  const cuaca = skills.getSkill("cuaca");
  assert.equal(cuaca.source, "owner");
  assert.equal(cuaca.description, "versi owner");
  assert.ok(!skills.allSkills().some((s) => s.name === "rusak"));
  fs.rmSync(process.env.SKILLS_DIR, { recursive: true, force: true });
  skills.resetCache();
});

test("use_skill: hanya ditawarkan bila fitur skill aktif; isinya berlabel trusted, bukan untrusted", async () => {
  assert.ok(!tools.toolNamesFor({}).includes("use_skill"), "tanpa ctx.skills tidak ditawarkan");
  const ctx = { skills: skills.forFeatures(new Set(["python", "skill"])), features: new Set(["python", "skill"]) };
  assert.ok(tools.toolNamesFor(ctx).includes("use_skill"));
  assert.ok(!tools.toolNamesFor({ ...ctx, features: new Set(["python"]) }).includes("use_skill"), "fitur skill mati");

  const ok = await tools.executeTool({ name: "use_skill", ok: true, arguments: { name: "qr_code" } }, ctx);
  const parsed = JSON.parse(ok.content);
  assert.equal(parsed.trusted_instructions, true);
  assert.equal(parsed.untrusted_data, undefined);
  assert.match(parsed.result.instructions, /qrcode/);

  const missing = JSON.parse((await tools.executeTool({ name: "use_skill", ok: true, arguments: { name: "cuaca" } }, { ...ctx, skills: skills.forFeatures(new Set(["skill", "web"])) })).content);
  assert.equal(missing.untrusted_data, true, "error tetap berlabel untrusted");
  assert.match(missing.result.error, /tidak ada/);
});

test("agent loop grup: indeks skill masuk prompt, use_skill memuat resep, lalu tugas diselesaikan", async () => {
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({
    chat: [
      { content: null, tool_calls: [toolCall("use_skill", { name: "ringkas_link" })] },
      "*Intinya:* contoh.",
    ],
  }).start();
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const result = await groupAgent.processGroupMessage({ sock, message: { key: { id: "s1", remoteJid: CHAT } }, groupId: CHAT, senderId: "62811", senderName: "Rehan", text: "@Grad ringkasin https://example.com/berita", explicitMention: true, replyToBot: false, quotedText: "" });
    const system = mock.state.chat[0].messages[0].content;
    assert.match(system, /Skill \(resep langkah kerja\) yang tersedia:\n- cuaca:/);
    assert.ok(mock.state.chat[0].tools.some((t) => t.function?.name === "use_skill"));
    const toolMessage = mock.state.chat[1].messages.find((m) => m.role === "tool");
    assert.match(toolMessage.content, /trusted_instructions/);
    assert.match(toolMessage.content, /web_fetch/);
    assert.equal(result.action, "reply");
    assert.equal(sent.at(-1).text, "*Intinya:* contoh.");

    features.setGroupFeature(CHAT, "skill", false, { role: "admin" });
    groupAgent.resetHistories();
    await groupAgent.processGroupMessage({ sock, message: { key: { id: "s2", remoteJid: CHAT } }, groupId: CHAT, senderId: "62811", senderName: "Rehan", text: "@Grad halo", explicitMention: true, replyToBot: false, quotedText: "" });
    assert.doesNotMatch(mock.state.chat.at(-1).messages[0].content, /Skill \(resep/);
    assert.ok(!mock.state.chat.at(-1).tools.some((t) => t.function?.name === "use_skill"));
  } finally {
    await mock.stop();
  }
});
