const QRCode = require("qrcode");

module.exports = {
  name: "qr",
  match: (text) => text === "/qr" || text.startsWith("/qr "),
  handler: async ({ sock, m, jid, text }) => {
    const payload = text.slice(4).trim();
    if (!payload) {
      await sock.sendMessage(jid, { text: "ℹ️ Kirim /qr <teks atau URL>" });
      return;
    }
    try {
      const buffer = await QRCode.toBuffer(payload, { width: 512, margin: 2 });
      await sock.sendMessage(jid, {
        image: buffer,
        caption: `🔍 QR untuk: ${payload.slice(0, 100)}`,
      });
    } catch (err) {
      console.error("Gagal membuat QR:", err);
      await sock.sendMessage(jid, { text: "❌ Gagal membuat QR" });
    }
  },
};
