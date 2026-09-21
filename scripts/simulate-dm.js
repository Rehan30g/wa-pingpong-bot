require("dotenv").config({ quiet: true });

const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");
const scheduler = require("../ai/scheduler");
const humanize = require("../ai/humanize");

const PHONE = "6285211111111";
const GROUP = "simulate-dm@g.us";

function fakeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, ...content, quoted: Boolean(options?.quoted) });
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
}

const scenarios = [
  "Halo Grad, kamu lagi sibuk?",
  "Menurutmu aku lebih baik resign atau lanjut aja?",
  "Ingetin aku 30 menit lagi minum obat ya",
  "Tolong sebarkan ke semua anggota kalau rapat besok batal",
  "jangan chat aku dulu ya",
];

async function main() {
  if (!groupAgent.isConfigured()) throw new Error("OPENROUTER_API_KEY belum dikonfigurasi di .env");
  process.env.AI_HUMAN_DELAY_SCALE = "0";
  process.env.AI_DM_DEBOUNCE_MS = "50";

  memoryStore.resetAllMemory();
  scheduler.clearJobs();
  // Anggap PHONE pernah aktif di grup sehingga masuk whitelist DM.
  memoryStore.recordParticipant({ phone: PHONE, name: "Rehan", groupId: GROUP, at: groupAgent.witTimestamp() });

  console.log(`Simulasi DM dengan ${groupAgent.config().jevModel} + ${groupAgent.config().chatModel}`);
  console.log(`Whitelist DM: ${memoryStore.canDirectMessage(PHONE)}\n`);

  const sock = fakeSock();
  for (let index = 0; index < scenarios.length; index++) {
    const text = scenarios[index];
    const sentBefore = sock.sent.length;
    const result = await directAgent.processDirectMessage({
      sock,
      message: { key: { id: `sim-${index}`, remoteJid: `${PHONE}@s.whatsapp.net` } },
      phone: PHONE,
      senderName: "Rehan",
      text,
      quotedText: "",
      media: null,
      isOwner: false,
    });
    const newMessages = sock.sent.slice(sentBefore);
    const lastReply = [...newMessages].reverse().find((item) => item.text);
    console.log(`[${index + 1}] Pengguna: ${text}`);
    if (result.decision) {
      console.log(`    Jev: action=${result.decision.action} intent=${result.decision.intent} conf=${result.decision.confidence}`);
    }
    const delivery = lastReply ? (lastReply.quoted ? ", quoted" : ", standalone") : "";
    console.log(`    Bot (${result.action}${delivery}): ${lastReply?.text || "(diam)"}\n`);
  }

  console.log("Gerbang DM proaktif:", {
    optOut: memoryStore.getDmMemory(PHONE).opt_out,
    bolehProaktif: scheduler.canProactivelyMessage(PHONE, Date.now()),
    jobMenunggu: scheduler.listJobs().length,
    jamTenang: humanize.isQuietHours(),
  });

  const reminder = scheduler.listJobs().find((job) => job.type === "reminder");
  if (reminder) console.log("Reminder terjadwal:", new Date(reminder.fire_at).toISOString(), "-", reminder.payload.text);
}

main().catch((error) => {
  console.error("Simulasi DM gagal:", error.response?.data || error.message);
  process.exitCode = 1;
});
