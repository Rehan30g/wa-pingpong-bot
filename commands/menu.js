const features = require("../ai/features");

// Contoh kemampuan Grad per fitur (hanya yang aktif di chat ini yang ditampilkan).
// Skill bawaan ditampilkan di baris fitur yang menaunginya (bukan daftar terpisah).
const ABILITIES = {
  web: "🔎 *Web* — cari info terbaru, ringkas link, cek hoaks, bandingin produk — _\"@Grad harga iPhone 17 sekarang?\"_",
  audio: "🎙️ *Voice note* — cukup kirim VN yang manggil Grad",
  media: "🖼️ *Gambar/video* — kirim/reply lalu tanya",
  stiker: "🗂️ *Stiker* — koleksi & kirim stiker — _\"@Grad simpan stiker ini\"_, _\"kirim stiker dong\"_",
  edit_media: "🎬 *Edit media* — stiker dari video/foto + teks, potong, kompres, ambil mp3 — _\"jadiin stiker 3 detik pertama, tulis GAS\"_",
  python: "🧮 *Python* — hitung, grafik, QR (link/WiFi/WA/kontak), kurs, cuaca, jadwal sholat, patungan, cicilan/KPR — _\"patungan dong: …\"_, _\"250 dolar berapa rupiah?\"_",
  dokumen: "📄 *Dokumen* — baca/ringkas PDF (termasuk hasil scan), Word, PPT, Excel; bikin PDF, Word, slide, Excel — _\"ringkas PDF ini\"_, _\"jadiin notulen tadi PDF\"_",
  reminder: "⏰ *Jadwal* — _\"ingetin grup besok jam 8 rapat\"_, _\"tiap Senin jam 7 cariin jadwal bola\"_",
  memori: "🧠 *Memori & catatan* — ingat fakta, catatan, notulen rapat — _\"inget ya aku alergi udang\"_, _\"bikin notulen rapat tadi\"_",
  latar: "🕒 *Tugas latar* — _\"riset mendalam bandingin 3 laptop gaming\"_",
  sosial: "💬 *Nimbrung* — kadang ikut ngobrol (bilang _\"grad diem dulu\"_ kalau lagi nggak mau)",
};

module.exports = {
  name: "menu",
  match: (text) => text === "/menu",
  handler: async ({ sock, jid, fromOwner }) => {
    const enabled = features.enabledSet(jid);
    const abilities = Object.entries(ABILITIES).filter(([name]) => enabled.has(name)).map(([, line]) => `• ${line}`);
    const menu = [
      "*📋 MENU GRAD*",
      "",
      "🤖 *Ngobrol sama Grad*",
      "Mention @Grad, sebut namanya (\"Gradd\" juga kebaca), atau reply pesannya. Nggak perlu perintah khusus:",
      ...abilities,
      "Minta hasilnya ke japri: _\"kirim ke DM aku aja\"_. Hentikan tugas: _\"stop\"_ / _\"batal\"_.",
      "",
      "✨ *Utilitas*",
      "/menu — daftar ini",
      "/react <emoji> — react ke pesan yang di-reply",
      "/qr <teks> — bikin QR code",
      "/s (reply gambar) — gambar jadi stiker",
      "/fitur — lihat fitur Grad yang aktif di grup ini",
      "",
      "🏓 *Game*",
      "/start — mulai ping-pong · pong — pukul · /score — skor · /stop — berhenti",
      "",
      "🛡️ *Owner, admin grup, atau pemegang veto*",
      "/memory — lihat memori & konteks Grad",
      "/clear — hapus percakapan aktif (memori tetap)",
      "/reset — hapus percakapan + seluruh memori grup",
      "Admin grup, lewat DM ke Grad: /grup lalu /fitur <no> <fitur> on|off",
    ];
    if (fromOwner) {
      menu.push(
        "",
        "👑 *Owner*",
        "/agent status|on|off|clear — kontrol agen (reminder tetap jalan saat off)",
        "/agent social on|off — nimbrung sosial di grup ini",
        "/stiker · /stiker lihat|buang <id> · /stiker kurasi|review — koleksi stiker",
        "/fitur global [<fitur> kunci|buka] — kunci fitur di semua grup (mis. python)",
        "Skill tambahan: taruh file .md di data/skills/ (format sama dengan ai/skills/builtin)",
        "/allow · /deny — aktifkan/nonaktifkan bot di grup",
        "/veto (reply/nomor) · /unveto · /veto list — akses pengelola",
        "/owner · /verify · /reboot",
        "Dashboard lokal: link di terminal bot, atau `npm run dashboard:link`",
      );
    }
    await sock.sendMessage(jid, { text: menu.join("\n") });
  },
};
