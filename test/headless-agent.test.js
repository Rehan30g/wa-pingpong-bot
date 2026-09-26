const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { testDir, cleanup } = setupIsolatedTestEnv("wa-test-headless-");
const { createStorage } = require("../ai/runtime/storage");
const { createHeadlessSession } = require("../scripts/headless-agent");

test.after(cleanup);

test("headless /task catat lalu baca memakai state sementara tanpa WhatsApp", async () => {
  const db = await createStorage(path.join(testDir, "headless.db"));
  let noteId;
  const glmClient = { chatCompletion: async (request) => {
    const goal = JSON.parse(request.messages[1].content.split("\n").slice(1).join("\n")).task_goal;
    const isRead = goal.startsWith("Baca catatan");
    return { text: JSON.stringify({
      plan_id: isRead ? "read_headless" : "create_headless", goal,
      steps: [{ step_index: 0, capability_name: isRead ? "read_note" : "create_note", logical_operation_id: isRead ? "read" : "create", arguments: isRead ? { note_id: noteId } : { title: "Uji", content: "Rapat Jumat jam 9 WIT" }, expected_result: isRead ? "Catatan dibaca" : "Catatan dibuat" }],
      final_response: isRead ? "Catatan terbaca" : "Catatan tersimpan",
    }), usage: { total_tokens: 100 } };
  } };
  try {
    const session = await createHeadlessSession({ storage: db.storage, glmClient });
    const created = await session.run("/task catat: Rapat Jumat jam 9 WIT");
    assert.equal(created.status, "succeeded");
    noteId = created.steps[0].result.note_id;
    assert.match(noteId, /^note_/);
    const read = await session.run("/task baca");
    assert.equal(read.status, "succeeded");
    assert.equal(read.steps[0].result.note_id, noteId);
    assert.equal(read.steps[0].result.content, "Rapat Jumat jam 9 WIT");
    await assert.rejects(session.run("/task kirim stiker"), /tidak didukung/);
  } finally { await db.close(); }
});
