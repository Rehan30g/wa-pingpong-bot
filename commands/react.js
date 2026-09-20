const USAGE = "ℹ️ Reply pesan, lalu kirim /react <emoji>";

module.exports = {
  name: "react",
  match: (text) => text === "/react" || text.startsWith("/react "),
  handler: async ({ sock, m, jid, text }) => {
    const emoji = text.replace(/^\/react\s*/, "").trim();
    const ctx = m.message?.extendedTextMessage?.contextInfo;
    const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    if (!emoji || !quoted || !ctx) {
      await sock.sendMessage(jid, { text: USAGE });
      return;
    }

    const key = {
      remoteJid: jid,
      id: ctx.stanzaId,
      fromMe: false,
      participant: ctx.participant,
    };

    await sock.sendMessage(jid, { react: { text: emoji, key } });
  },
};
