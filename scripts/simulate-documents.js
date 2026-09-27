// Simulasi fitur dokumen dengan API nyata (Jev + GLM + sandbox + OCR Gemini), socket WA di-mock.
// Pakai: npm run simulate:documents -- <file.pdf|docx|pptx|xlsx> ["pertanyaan 1" ...]
// Dokumen hasil Grad disimpan ke folder sementara yang dicetak di akhir. API key tidak pernah dicetak.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grad-doc-sim-"));
process.env.AI_MEMORY_FILE = path.join(tmp, "ai-memory.json");
process.env.AGENT_JOBS_FILE = path.join(tmp, "agent-jobs.json");
process.env.FEATURES_FILE = path.join(tmp, "features.json");
process.env.NOTEBOOK_FILE = path.join(tmp, "notebook.json");
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.PYTHON_CACHE_DIR = path.resolve("./data/pyodide-cache");
process.env.AI_HUMAN_DELAY_SCALE = "0";
if (process.env.SIM_NO_PROXY === "1") process.env.OPENROUTER_PROXY_URL = "";

const groupAgent = require("../ai/group-agent");

const GROUP = "120363000000777@g.us";
const [docPath, ...questions] = process.argv.slice(2);
let id = 0;

function sock() {
  return {
    sendMessage: async (_jid, content) => {
      const at = new Date().toISOString().slice(11, 19);
      if (content.react) console.log(`   ${at} [react ${content.react.text}]`);
      else if (content.document || content.image || content.sticker) {
        const name = content.fileName || `hasil-${id}${content.image ? ".png" : ".webp"}`;
        fs.writeFileSync(path.join(tmp, name), content.document || content.image || content.sticker);
        console.log(`   ${at} [${content.document ? "dokumen" : "media"} → ${path.join(tmp, name)}]`);
      } else console.log(`   ${at} ${groupAgent.config().botName}: ${String(content.text).replace(/\n/g, "\n      ")}`);
      return { key: { id: `bot-${++id}` } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

async function say(text, extra = {}) {
  id += 1;
  console.log(`\n>> Rehan: ${text}`);
  const started = Date.now();
  const result = await groupAgent.processGroupMessage({
    sock: sock(),
    message: { key: { id: `u-${id}`, remoteJid: GROUP }, message: { conversation: text } },
    groupId: GROUP,
    senderId: "628111111111",
    senderName: "Rehan",
    text,
    explicitMention: groupAgent.textMentionsBotName(text),
    replyToBot: false,
    quotedText: "",
    ...extra,
  });
  console.log(`   = ${result.action}${result.toolCounts ? ` tools=${JSON.stringify(result.toolCounts)}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

(async () => {
  if (!docPath || !fs.existsSync(docPath)) {
    console.log("Pakai: npm run simulate:documents -- <file> [\"pertanyaan\" ...]");
    process.exit(1);
  }
  const name = path.basename(docPath);
  const buffer = fs.readFileSync(docPath);
  groupAgent.setDocumentLoader(async (ref) => (ref?.key?.id === "doc-1" ? { buffer, fileName: name } : null));
  const prompts = questions.length ? questions : [`grad ringkasin ${name} tadi`, "grad bikin versi PDF dari ringkasan itu"];
  try {
    id = 0;
    console.log(`\n>> Rehan: [dokumen: ${name}]`);
    await groupAgent.processGroupMessage({
      sock: sock(),
      message: { key: { id: "doc-1", remoteJid: GROUP } },
      groupId: GROUP, senderId: "628111111111", senderName: "Rehan",
      text: `[dokumen: ${name} · ${Math.max(1, Math.round(buffer.length / 1024))} KB]`,
      explicitMention: false, replyToBot: false, quotedText: "",
      document: { name, size: buffer.length },
    });
    for (const text of prompts) await say(text);
  } catch (error) {
    console.log(`   ! gagal: ${String(error.message).slice(0, 200)}`);
  }
  console.log(`\nFile hasil: ${tmp}`);
  process.exit(0);
})();
