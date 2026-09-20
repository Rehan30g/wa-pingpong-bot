module.exports = {
  name: "menu",
  match: (text) => text === "/menu",
  handler: async ({ sock, m, jid, text, senderTag, fromOwner, data }) => {
    const menu = [
      "*📋 DAFTAR PERINTAH BOT*",
      "",
      "🎮 *Game Ping-Pong*",
      "/menu — lihat daftar perintah",
      "/start — mulai game ping-pong",
      "/pong — main ping-pong",
      "/score — lihat skor game",
      "/stop — stop game",
      "",
      "✨ *Utilitas*",
      "/react <emoji> — react ke pesan yang di-reply",
      "/qr <teks> — generate QR code jadi gambar",
      "/s (reply gambar) — ubah gambar jadi stiker",
      "",
      "👑 *Admin/Owner*",
      "/owner — info owner",
      "/verify — verifikasi",
      "/reboot — restart bot",
      "/allow — izinkan grup",
      "/deny — tolak grup",
    ].join("\n");

    await sock.sendMessage(jid, { text: menu });
  },
};
