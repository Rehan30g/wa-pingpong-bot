const sharp = require("sharp");

// Kontrak downloadMedia(m): async, return Buffer media dari pesan m (current atau quoted) — disediakan integrator, bukan di sini.
module.exports = {
  name: "sticker",
  match: (text) => text === "/s" || text === "/stiker" || text === "/sticker",
  handler: async ({ sock, m, jid, text, downloadMedia }) => {
    try {
      const quotedImage = m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      const msg = quotedImage ? { ...m, message: m.message.extendedTextMessage.contextInfo.quotedMessage } : m;
      const hasImage = m.message?.imageMessage || quotedImage;
      if (!hasImage) {
        await sock.sendMessage(jid, { text: "ℹ️ Kirim/reply gambar dengan caption /s untuk membuat stiker." });
        return;
      }
      const buffer = await downloadMedia(msg);
      const webp = await sharp(buffer)
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp()
        .toBuffer();
      await sock.sendMessage(jid, { sticker: webp });
    } catch (err) {
      console.error("Sticker error:", err);
      await sock.sendMessage(jid, { text: "❌ Gagal membuat stiker." });
    }
  }
};
