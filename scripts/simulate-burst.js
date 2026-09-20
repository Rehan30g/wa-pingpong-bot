require("dotenv").config({ quiet: true });

const agent = require("../ai/group-agent");

async function main() {
  agent.resetHistories();
  const groupId = "burst-test@g.us";
  const sent = [];
  const sock = {
    sendMessage: async (_jid, content) => {
      sent.push(content);
      return { key: { id: `bot-${sent.length}` } };
    },
  };

  const texts = ["Grad", "jawab aku lah", "aku mau tanya", "kenapa langit biru?"];
  const jobs = texts.map((text, index) => agent.processGroupMessage({
    sock,
    message: { key: { remoteJid: groupId, id: `user-${index}`, participant: "user@s.whatsapp.net" } },
    groupId,
    senderId: "sim-user",
    senderName: "Rehan",
    text,
    explicitMention: agent.textMentionsBotName(text),
    replyToBot: false,
    quotedText: "",
  }));

  const results = await Promise.all(jobs);
  console.log("Riwayat yang dibaca:");
  for (const item of agent.getHistory(groupId)) console.log(`- ${item.sender}: ${item.text}`);
  console.log("Hasil tiap pesan:", results.map((result) => result.action).join(", "));
  console.log("Jumlah aksi terkirim:", sent.length);
  if (sent[0]?.text) console.log("Balasan akhir:", sent[0].text);
  if (sent[0]?.react) console.log("Reaction akhir:", sent[0].react.text);
}

main().catch((error) => {
  console.error(error.response?.data || error);
  process.exitCode = 1;
});
