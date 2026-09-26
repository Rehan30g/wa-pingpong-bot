// Simulasi demo M1 dengan API nyata (Jev + GLM + web search + Gemini), socket WA di-mock.
// Pakai: node scripts/simulate-agent-loop.js [voice-note.ogg] [musik.ogg]
// SIM_NO_PROXY=1 untuk mesin tanpa proxy 8118. API key tidak pernah dicetak.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grad-sim-"));
process.env.AI_MEMORY_FILE = path.join(tmp, "ai-memory.json");
process.env.AGENT_JOBS_FILE = path.join(tmp, "agent-jobs.json");
if (process.env.SIM_NO_PROXY === "1") process.env.OPENROUTER_PROXY_URL = "";

const groupAgent = require("../ai/group-agent");
const { processVoiceNote } = require("../ai/audio/voice-notes");

const GROUP = "120363000000999@g.us";
const [voicePath, musicPath] = process.argv.slice(2);
let id = 0;

function sock() {
  return {
    sendMessage: async (jid, content) => {
      const at = new Date().toISOString().slice(11, 19);
      if (content.react) console.log(`   ${at} [react ${content.react.text}]`);
      else console.log(`   ${at} ${groupAgent.config().botName}: ${content.text.replace(/\n/g, "\n      ")}`);
      return { key: { id: `bot-${++id}` } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

async function say(sender, text, extra = {}) {
  id += 1;
  console.log(`\n>> ${sender}: ${text}`);
  const started = Date.now();
  const result = await groupAgent.processGroupMessage({
    sock: sock(),
    message: { key: { id: `u-${id}`, remoteJid: GROUP }, message: { conversation: text } },
    groupId: GROUP,
    senderId: sender === "Rehan" ? "628111111111" : "628222222222",
    senderName: sender,
    text,
    explicitMention: groupAgent.textMentionsBotName(text),
    replyToBot: false,
    quotedText: "",
    ...extra,
  });
  console.log(`   = ${result.action}${result.toolCounts ? ` tools=${JSON.stringify(result.toolCounts)}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return result;
}

async function voice(sender, file, extra = {}) {
  const note = await processVoiceNote({
    audioMessage: { seconds: 0, ptt: true },
    messageId: `vn-${file}`,
    download: async () => fs.readFileSync(file),
    context: { botName: groupAgent.config().botName, participants: ["Rehan", "Budi"], recent: groupAgent.getHistory(GROUP).slice(-5).map((e) => `[${e.sender}] ${e.text}`) },
  });
  return { note, result: await say(sender, note.text, { audio: note.audio, ...extra }) };
}

(async () => {
  if (!groupAgent.isConfigured()) throw new Error("OPENROUTER_API_KEY belum diisi");
  const bot = groupAgent.config().botName;
  await say("Rehan", `@${bot} lagi ngapain?`);
  await say("Budi", `@${bot} harga iPhone 17 di Indonesia sekarang berapa? bandingin sama iPhone 16`);
  await say("Rehan", `@${bot} rangkum link ini https://id.wikipedia.org/wiki/WhatsApp`);
  if (voicePath) {
    await say("Rehan", "rapat besok jam 10 pagi di ruang 2 ya, Budi bawa proyektor");
    await voice("Budi", voicePath);
  }
  if (musicPath) {
    const { note } = await voice("Budi", musicPath, { explicitMention: false });
    await say("Rehan", `@${bot} ini lagu apa?`, { quotedText: note.text, audio: note.audio });
  }
  const usage = require("../ai/agent/usage").today();
  console.log(`\nTotal: ${usage.tasks} tugas, ${usage.searches} pencarian, ${usage.fetches} baca link, ${usage.audio} audio, biaya $${usage.cost.toFixed(4)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((error) => {
  console.error("GAGAL:", error.message);
  process.exit(1);
});
