require("dotenv").config({ quiet: true });

const agent = require("../ai/group-agent");

async function main() {
  const groupId = "memory-test@g.us";
  agent.resetGroupContext(groupId);

  const conversation = [
    ["Rehan", "+6285211111111 (085211111111)", "Grad, nama saya Rehan."],
    ["Grad", "BOT", "Halo Rehan."],
    ["Rehan", "+6285211111111 (085211111111)", "Saya lebih suka jawaban singkat tanpa emoji."],
    ["Budi", "+6285222222222 (085222222222)", "Besok rapat jam 9 WIT."],
    ["Rehan", "+6285211111111 (085211111111)", "Oke, agenda utamanya evaluasi server."],
    ["Grad", "BOT", "Siap."],
    ["Budi", "+6285222222222 (085222222222)", "Masalah 502 masih belum selesai."],
    ["Rehan", "+6285211111111 (085211111111)", "Nanti lanjut cek nginx."],
  ];

  for (const [sender, senderId, text] of conversation) {
    agent.remember(groupId, { sender, senderId, text, isBot: sender === "Grad" });
  }

  await agent.compactGroupMemory(groupId);
  console.log(agent.getMemoryDisplay(groupId));
  agent.resetGroupContext(groupId);
}

main().catch((error) => {
  console.error(error.response?.data || error);
  process.exitCode = 1;
});
