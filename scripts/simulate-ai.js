require("dotenv").config({ quiet: true });

const agent = require("../ai/group-agent");

const reactionMap = {
  react_ack: "👍",
  react_heart: "❤️",
  react_laugh: "😂",
  react_surprised: "😮",
};

const scenarios = [
  {
    name: "Undangan terbuka kepada siapa pun",
    messages: [
      ["Rehan", "Kosong nih, siapapun jawab dong"],
    ],
  },
  {
    name: "Pesan ambigu seperti pada screenshot",
    messages: [
      ["Rehan", "Cara jadi nyata"],
    ],
    explicitMention: true,
  },
  {
    name: "Pertanyaan faktual seperti pada screenshot",
    messages: [
      ["Rehan", "Kenapa langit biru"],
    ],
    explicitMention: true,
  },
  {
    name: "Obrolan biasa antarmanusia",
    messages: [
      ["Andi", "Nanti makan siang di mana?"],
      ["Sari", "Di warung depan saja."],
      ["Andi", "Oke, jam dua belas ya."],
    ],
  },
  {
    name: "Ucapan terima kasih setelah dibantu bot",
    messages: [
      ["Aira", "File rapatnya ada di folder Dokumen Bersama.", true],
      ["Budi", "Sip, makasih banyak!"],
    ],
    replyToBot: true,
    quotedText: "File rapatnya ada di folder Dokumen Bersama.",
  },
  {
    name: "Candaan antarteman",
    messages: [
      ["Rina", "Katanya datang jam 8, ternyata jam 8 malam 😂"],
      ["Doni", "Waduh definisi tepat waktu versi dia itu."],
    ],
  },
  {
    name: "Pertanyaan langsung kepada bot",
    messages: [
      ["Tono", "@Aira, bedanya RAM dan penyimpanan itu apa?"],
    ],
    explicitMention: true,
  },
  {
    name: "Grup bingung menghadapi masalah teknis",
    messages: [
      ["Andi", "Website masih 502 setelah server direstart."],
      ["Budi", "Service aplikasinya hidup, tapi nginx tetap bad gateway."],
      ["Andi", "Kita harus cek bagian mana lagi ya?"],
    ],
  },
  {
    name: "Pertanyaan kepada anggota lain, bukan bot",
    messages: [
      ["Maya", "Rudi, kamu sudah kirim laporan ke kantor?"],
      ["Rudi", "Belum, nanti sore aku kirim."],
    ],
  },
  {
    name: "Apresiasi hangat langsung kepada bot",
    messages: [
      ["Aira", "Semoga presentasinya lancar ya.", true],
      ["Nina", "Aira baik banget, makasih sudah nemenin persiapannya ❤️"],
    ],
    replyToBot: true,
    quotedText: "Semoga presentasinya lancar ya.",
  },
  {
    name: "Nama Grad disebut tanpa tag metadata WhatsApp",
    messages: [
      ["Riko", "Grad bantu jelasin kenapa internetnya lambat dong"],
    ],
  },
  {
    name: "Terima kasih ditujukan kepada Grad",
    messages: [
      ["Grad", "Link rapatnya sudah aku kirim.", true],
      ["Sinta", "Makasih Grad"],
    ],
  },
  {
    name: "Terima kasih ditujukan kepada anggota lain",
    messages: [
      ["Budi", "Aku sudah bantu upload filenya."],
      ["Sinta", "Makasih Budi"],
    ],
  },
];

async function runScenario(scenario, index) {
  const groupId = `simulation-${index}@g.us`;
  const messages = scenario.messages.map(([sender, text, isBot]) => ({ sender, text, isBot: Boolean(isBot) }));
  for (const message of messages) agent.remember(groupId, message);

  const last = messages.at(-1);
  const latestMessage = {
    sender: last.sender,
    sender_id: `sim-user-${index}`,
    text: last.text,
  };
  const explicitMention = Boolean(scenario.explicitMention) || agent.textMentionsBotName(last.text);
  const replyToBot = Boolean(scenario.replyToBot);
  const decision = await agent.decideAction({
    groupId,
    latestMessage,
    explicitMention,
    replyToBot,
    quotedText: scenario.quotedText || "",
  });

  if (
    decision.action === "ignore" &&
    decision.gratitudeTarget === "bot" &&
    decision.gratitudeConfidence >= 0.55
  ) {
    decision.action = /[❤♥]|\b(sayang|love)\b/iu.test(last.text) ? "react_heart" : "react_ack";
    decision.confidence = decision.gratitudeConfidence;
  }

  if (
    (decision.action === "react_ack" || decision.action === "react_heart") &&
    decision.gratitudeTarget !== "bot"
  ) {
    decision.action = "ignore";
  }
  if (decision.action === "react_ack" || decision.action === "react_heart") {
    decision.confidence = Math.max(decision.confidence, decision.gratitudeConfidence || 0);
  }

  const cfg = agent.config();
  let execution = "DIAM";
  let reply = "";
  const directlyAddressed = explicitMention || replyToBot;
  const shouldReply =
    (decision.action === "reply" && (decision.confidence >= cfg.replyConfidence || directlyAddressed)) ||
    (decision.action === "ignore" && directlyAddressed);
  if (shouldReply) {
    execution = "JAWAB";
    const generated = await agent.generateReply({ groupId, latestMessage, quotedText: scenario.quotedText || "" });
    reply = generated.text;
    execution += generated.replyToEntryId == null ? " (standalone)" : ` (reply #${generated.replyToEntryId})`;
  } else if (
    reactionMap[decision.action] &&
    (decision.confidence >= cfg.reactConfidence || (directlyAddressed && decision.confidence >= cfg.directReactConfidence))
  ) {
    execution = `REACT ${reactionMap[decision.action]}`;
  }

  console.log(`\n[${index + 1}] ${scenario.name}`);
  for (const message of messages) console.log(`  ${message.sender}: ${message.text}`);
  console.log(`  Jev: ${decision.action} (${(decision.confidence * 100).toFixed(1)}%), gratitude=${decision.gratitudeTarget} (${(decision.gratitudeConfidence * 100).toFixed(1)}%)`);
  console.log(`  Eksekusi bot: ${execution}`);
  if (reply) console.log(`  GLM: ${reply}`);
}

async function main() {
  if (!agent.isConfigured()) throw new Error("OPENROUTER_API_KEY belum dikonfigurasi di .env");
  console.log(`Simulasi ${scenarios.length} percakapan dengan ${agent.config().jevModel} + ${agent.config().chatModel}`);
  for (let i = 0; i < scenarios.length; i++) await runScenario(scenarios[i], i);
}

main().catch((error) => {
  console.error("Simulasi gagal:", error.response?.data || error.message);
  process.exitCode = 1;
});
