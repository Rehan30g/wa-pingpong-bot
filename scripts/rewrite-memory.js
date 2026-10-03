// Pratinjau penulisan ulang memori lama (tanpa menyimpan apa pun ke file produksi).
//   npm run memory:rewrite-preview
// Penulisan ulang yang sebenarnya berjalan sekali di dalam bot setelah restart
// (ai/memory/rewrite.js, dengan backup ke data/backup/).
const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config({ quiet: true });

const source = path.resolve(process.env.AI_MEMORY_FILE || "./ai-memory.json");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-preview-"));
fs.copyFileSync(source, path.join(temp, "ai-memory.json"));
process.env.AI_MEMORY_FILE = path.join(temp, "ai-memory.json");

const groupAgent = require("../ai/group-agent");
const { rewriteAll } = require("../ai/memory/rewrite");

(async () => {
  if (!groupAgent.isConfigured()) throw new Error("API key belum diset");
  const results = await rewriteAll({ glm: groupAgent.createChatGlm(), model: groupAgent.config().chatModel, apply: false, log: (line) => console.error(line) });
  for (const item of results) {
    console.log(`\n==================== ${item.kind.toUpperCase()} ${item.id}`);
    if (item.error) { console.log("GAGAL:", item.error); continue; }
    console.log(`--- SEBELUM (${item.before.glm.length} karakter)\n${item.before.glm}`);
    console.log(`--- SESUDAH (${item.after.glm.length} karakter)\n${item.after.glm}`);
    console.log(`--- konteks Jev sesudah\n${item.after.jev}`);
    if (item.nicknames.length) console.log(`--- nama panggilan: ${item.nicknames.map((n) => `${n.nickname} → ${n.phone}`).join(", ")}`);
  }
})().catch((error) => { console.error("Pratinjau gagal:", error.message); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
