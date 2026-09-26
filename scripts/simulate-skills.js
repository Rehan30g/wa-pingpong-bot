// Simulasi skill bawaan dengan API nyata (Jev + GLM + sandbox Python), socket WA di-mock.
// Pakai: npm run simulate:skills [-- "pesan 1" "pesan 2" ...]
// Gambar hasil disimpan ke folder sementara yang dicetak di akhir. API key tidak pernah dicetak.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grad-skill-sim-"));
process.env.AI_MEMORY_FILE = path.join(tmp, "ai-memory.json");
process.env.AGENT_JOBS_FILE = path.join(tmp, "agent-jobs.json");
process.env.FEATURES_FILE = path.join(tmp, "features.json");
process.env.NOTEBOOK_FILE = path.join(tmp, "notebook.json");
process.env.WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.PYTHON_CACHE_DIR = path.resolve("./data/pyodide-cache");
process.env.AI_HUMAN_DELAY_SCALE = "0";
if (process.env.SIM_NO_PROXY === "1") process.env.OPENROUTER_PROXY_URL = "";

const groupAgent = require("../ai/group-agent");

const GROUP = "120363000000888@g.us";
const DEFAULT_PROMPTS = [
  "Grad buat qr hello world",
  "grad 250 dolar berapa rupiah sekarang?",
  "grad cuaca jayapura besok gimana",
  "grad maghrib di jayapura hari ini jam berapa",
  "grad patungan dong: aku nasi goreng 35rb, Budi mie ayam 28rb, es teh 2 buat berdua 10rb, pajak 10%, aku yang bayar semua",
];
let id = 0;
let files = 0;

function sock() {
  return {
    sendMessage: async (_jid, content) => {
      const at = new Date().toISOString().slice(11, 19);
      const media = content.image || content.sticker || content.video || content.audio;
      if (content.react) console.log(`   ${at} [react ${content.react.text}]`);
      else if (media) {
        const file = path.join(tmp, `hasil-${++files}${content.image ? ".png" : content.sticker ? ".webp" : ".bin"}`);
        fs.writeFileSync(file, Buffer.isBuffer(media) ? media : fs.readFileSync(media.url));
        console.log(`   ${at} [${content.image ? "gambar" : "media"} → ${file}]`);
      } else console.log(`   ${at} ${groupAgent.config().botName}: ${String(content.text).replace(/\n/g, "\n      ")}`);
      return { key: { id: `bot-${++id}` } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

async function say(text) {
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
  });
  console.log(`   = ${result.action}${result.toolCounts ? ` tools=${JSON.stringify(result.toolCounts)}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

(async () => {
  const prompts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PROMPTS;
  for (const text of prompts) {
    try {
      await say(text);
    } catch (error) {
      console.log(`   ! gagal: ${String(error.message).slice(0, 200)}`);
    }
  }
  console.log(`\nFile hasil: ${tmp}`);
  process.exit(0);
})();
