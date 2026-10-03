const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-rewrite-");
const path = require("node:path");
const fs = require("node:fs");
process.env.MEMORY_BACKUP_DIR = path.join(testDir, "backup");

const test = require("node:test");
const assert = require("node:assert");
const memoryStore = require("../ai/memory-store");
const members = require("../ai/agent/members");
const { rewriteAll, scheduleMemoryRewrite, REWRITE_VERSION } = require("../ai/memory/rewrite");

test.after(() => cleanup());

const GROUP = "120363555000444@g.us";
const RIC = "6281111110001";

function seed() {
  memoryStore.resetAllMemory();
  members.reset();
  memoryStore.recordParticipant({ phone: RIC, name: "Dimas Pratama", groupId: GROUP });
  memoryStore.setGroupMemory(GROUP, { glm: "Dimas (julukan 'dim'). Belum selesai: 20 butir remeh… bot bilang untung 74rb (salah).", jev: "konteks lama" });
}

const fakeGlm = (payload) => ({ calls: [], async chatCompletion(request) { this.calls.push(request); return { text: JSON.stringify(payload) }; } });

test("pratinjau (apply=false) tidak mengubah memori; apply=true menulis ulang & belajar nama panggilan", async () => {
  seed();
  const glm = fakeGlm({ glm_memory: "Dimas Pratama (dim) jualan headset. Hitungan rugi belum jelas.", jev_context: "Dimas mention bot untuk validasi angka.", nicknames: [{ phone: RIC, nickname: "dim" }, { phone: "6289999999999", nickname: "orang luar" }] });
  const preview = await rewriteAll({ glm, model: "m", apply: false });
  assert.match(preview[0].before.glm, /untung 74rb/);
  assert.match(memoryStore.getGroupMemory(GROUP).glm, /untung 74rb/, "pratinjau tidak menyimpan");
  assert.match(glm.calls[0].messages[0].content, /maksimal 5/);

  const applied = await rewriteAll({ glm, model: "m", apply: true, learnNicknames: members.learnNicknames });
  assert.equal(memoryStore.getGroupMemory(GROUP).glm, "Dimas Pratama (dim) jualan headset. Hitungan rugi belum jelas.");
  assert.deepEqual(applied[0].learned, [{ phone: RIC, nickname: "dim" }], "nomor di luar grup diabaikan");
  assert.deepEqual(memoryStore.getPerson(RIC).nicknames, ["dim"]);
});

test("dijadwalkan sekali per versi, dengan backup file memori; gagal → dicoba lagi lain kali", async () => {
  seed();
  memoryStore.save();
  const logs = [];
  const timer = scheduleMemoryRewrite({ glm: fakeGlm({ glm_memory: "ringkas", jev_context: "j", nicknames: [] }), model: "m", learnNicknames: members.learnNicknames, delayMs: 10, log: (line) => logs.push(line) });
  assert.ok(timer);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(memoryStore.getAgentSettings().memory_rewrite_version, REWRITE_VERSION);
  assert.equal(memoryStore.getGroupMemory(GROUP).glm, "ringkas");
  assert.equal(fs.readdirSync(process.env.MEMORY_BACKUP_DIR).length, 1, "backup dibuat sebelum menulis ulang");
  assert.equal(scheduleMemoryRewrite({ glm: fakeGlm({}), model: "m", delayMs: 10 }), null, "sudah versi terbaru → tidak jalan lagi");

  memoryStore.setAgentSettings({ memory_rewrite_version: 0 });
  const broken = { async chatCompletion() { return { text: "bukan json" }; } };
  scheduleMemoryRewrite({ glm: broken, model: "m", delayMs: 10, log: (line) => logs.push(line) });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(memoryStore.getAgentSettings().memory_rewrite_version, 0, "gagal → versi tidak dinaikkan");
  assert.equal(memoryStore.getGroupMemory(GROUP).glm, "ringkas", "memori tidak rusak saat gagal");
});

test("compact grup belajar nama panggilan diam-diam (tanpa Grad bicara)", async () => {
  seed();
  const learned = await members.learnNicknames(GROUP, [{ phone: RIC, nickname: "dim" }, { phone: RIC, nickname: "Dimas Pratama" }]);
  assert.deepEqual(learned, [{ phone: RIC, nickname: "dim" }], "nama WA sendiri tidak disimpan sebagai panggilan");
});

test("compact grup sungguhan: nama panggilan dari obrolan tersimpan dan bisa dipakai untuk tag", async () => {
  seed();
  const groupAgent = require("../ai/group-agent");
  const mentions = require("../ai/agent/mentions");
  groupAgent.resetHistories();
  process.env.OPENROUTER_API_KEY = "test-key";
  for (let index = 0; index < 8; index++) {
    groupAgent.remember(GROUP, { sender: "Rehan", senderId: "6281111110003", text: `dim, gimana jualan hari ini? (${index})` });
    groupAgent.remember(GROUP, { sender: "Dimas Pratama", senderId: RIC, text: `aman bos (${index})` });
  }
  const payload = { glm_memory: "Rehan memanggil Dimas 'dim'.", jev_context: "obrolan jualan", people: [], relationships: [], nicknames: [{ phone: RIC, nickname: "dim" }] };
  const glmClient = { async chatCompletion() { return { text: JSON.stringify(payload) }; } };
  const ok = await groupAgent.compactGroupMemory(GROUP, { glmClient });
  assert.equal(ok, true);
  assert.deepEqual(memoryStore.getPerson(RIC).nicknames, ["dim"]);
  await members.groupMembers(GROUP, { fresh: true });
  assert.deepEqual((await mentions.applyMentions(GROUP, "@dim dicariin")).mentions, [`${RIC}@s.whatsapp.net`]);
  delete process.env.OPENROUTER_API_KEY;
});
