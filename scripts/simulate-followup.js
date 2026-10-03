// Validasi API nyata: lanjutan dialog setelah Grad menjawab (kasus nyata 2 Okt, harga
// Xiaomi 14T → "Gile" → "MAHAL" → reply "Tau ga" → "Ha" → "Dongo").
//   npm run simulate:followup [-- --repeat 2]
const path = require("path");
const { setupSimulatorEnv } = require("./simulator-setup");
const { cleanup, tempDir } = setupSimulatorEnv();
require("dotenv").config({ quiet: true });
for (const [key, name] of [["FEATURES_FILE", "features.json"], ["NOTEBOOK_FILE", "notebook.json"], ["STICKER_DIR", "stickers"], ["WORKSPACE_DIR", "workspace"], ["RUNTIME_SETTINGS_FILE", "runtime.json"]]) process.env[key] = path.join(tempDir, name);
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";

const agent = require("../ai/group-agent");
const proactive = require("../ai/agent/proactive");
const REPEAT = Math.max(1, Number(process.argv.includes("--repeat") ? process.argv[process.argv.indexOf("--repeat") + 1] : 1));
const ME = { id: "6281111110003", name: "Rehan" };
const PRICE = "harga Xiaomi 14T sekarang kisaran segini (garansi resmi):\n• 12/256GB: ±Rp6,5–6,6 jt\n• 12/512GB: ±Rp6,3–7 jt\n• Harga resmi Xiaomi: 12/256 mulai Rp6,499 jt, 12/512 Rp6,999 jt\n\nstok unit baru udah mulai tipis karena penerusnya udah rilis, jadi harga toko bisa naik-turun.";
const SCRIPT = [
  ["Gile"],
  ["MAHAL"],
  ["Tau ga", { replyToBot: true, quotedText: PRICE }],
  ["Ha"],
  ["Dongo"],
];

(async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum diset");
  for (let round = 1; round <= REPEAT; round++) {
    const groupId = `1203630077${Math.floor(Math.random() * 1e8)}@g.us`;
    proactive.reset();
    const now = Date.now();
    agent.remember(groupId, { sender: ME.name, senderId: ME.id, text: "@Grad harga xiaomi 14t sekarang brp", mentionedBot: true, at: now - 11 * 60_000 });
    agent.remember(groupId, { sender: "Grad", senderId: "BOT", isBot: true, text: PRICE, at: now - 60_000 });
    console.log(`\n=== Putaran ${round}\n  Grad: ${PRICE.split("\n")[0]} …`);
    for (const [text, extra = {}] of SCRIPT) {
      const sent = [];
      const sock = {
        sendMessage: async (jid, content) => { sent.push(content.react ? `[reaction ${content.react.text}]` : content.sticker ? "[stiker]" : content.text); return { key: { id: `s${Math.random()}` } }; },
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
      };
      const started = Date.now();
      const result = await agent.processGroupMessage({ sock, groupId, senderId: ME.id, senderName: ME.name, text, message: { key: { id: `m${Math.random()}`, remoteJid: groupId } }, explicitMention: false, replyToBot: false, quotedText: "", ...extra });
      const jev = result.decision?.jevAction || result.decision?.action || "-";
      console.log(`  ${ME.name}: ${text}${extra.replyToBot ? " (reply ke harga)" : ""}`);
      console.log(`    → jev=${jev} hasil=${result.action}${result.reason ? `(${result.reason})` : ""} ${Date.now() - started}ms${sent.length ? `  Grad: ${sent.join(" / ")}` : ""}`);
    }
  }
})().catch((error) => { console.error("Simulasi gagal:", error.message); process.exitCode = 1; }).finally(() => cleanup());
