const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const { downloadContentFromMessage, getContentType } = require("@whiskeysockets/baileys");
const commands = require("fs")
  .readdirSync("./commands")
  .filter((f) => f.endsWith(".js"))
  .map((f) => require(`./commands/${f}`));
const pino = require("pino");
const readline = require("readline");
const childProcess = require("child_process");
const fs = require("fs");

const DATA_FILE = process.env.BOT_DATA_FILE || "./data.json";
let data = { owner: null, allowedGroups: [] };
if (fs.existsSync(DATA_FILE)) {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
}
const saveData = () => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// ---- state game per grup ----
const games = new Map(); // groupId -> { ball, rally, scores: {jid: {name, score}} }

// ---- verifikasi: kode menunggu input di terminal ----
let pendingVerify = null; // { code, userJid (nomor), sendJid (jid utk kirim), userName, expires }

// ---- reboot: respawn proses (untuk memuat kode yang diubah) ----
function realReboot() {
  console.log("[*] Restarting bot...");
  const respawn = childProcess.spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  respawn.unref();
  process.exit(0);
}
let rebootFn = realReboot;
let rebootDelay = 1500;

function handleCodeInput(val) {
  val = (val || "").trim();
  if (!pendingVerify) {
    return "[!] Tidak ada permintaan verifikasi. Ketik /verify di WhatsApp dulu.";
  }
  if (Date.now() > pendingVerify.expires) {
    pendingVerify = null;
    return "[!] Kode sudah kedaluwarsa. Minta user kirim /verify lagi.";
  }
  if (val === pendingVerify.code) {
    data.owner = pendingVerify.userJid;
    saveData();
    const msg = `[+] Berhasil! ${pendingVerify.userName} sekarang adalah OWNER.`;
    if (sock) {
      sock.sendMessage(pendingVerify.sendJid, { text: "✅ Verifikasi berhasil! Kamu sekarang OWNER. Kirim /allow di grup untuk mengaktifkan bot." })
        .catch((e) => console.error("[!] Gagal kirim pesan konfirmasi:", e.message));
    }
    pendingVerify = null;
    return msg;
  }
  return "[x] Kode salah! Coba lagi.";
}

let rl = null;
function initReadline() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askCode = () => {
    rl.question(">> Masukkan kode verifikasi: ", (input) => {
      console.log(handleCodeInput(input));
      askCode();
    });
  };
  askCode();
}

let sock = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["PingPong Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n[*] Scan QR ini dengan WhatsApp (Perangkat Tertaut):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("[+] Bot terhubung!");
      console.log("[i] Kirim /verify dari WhatsApp untuk menjadi owner.");
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[!] Koneksi terputus (code=${code}, reason=${DisconnectReason[code] ?? lastDisconnect?.error?.message})`);
      if (code === DisconnectReason.loggedOut) {
        console.log("[!] Ter-logout. Hapus folder auth dan scan ulang.");
        process.exit(0);
      }
      console.log("[!] Koneksi terputus, menyambung ulang...");
      startBot();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      try {
        await handleMessage(m);
      } catch (e) {
        console.error("[E]", e);
      }
    }
  });
}

function getText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    ""
  ).trim();
}

// ---- helper download media (untuk stiker dll) ----
async function downloadMedia(m) {
  const msg = m.message;
  const type = getContentType(msg);
  if (!msg[type] || !msg[type].url) return null;
  const stream = await downloadContentFromMessage(msg[type], type.replace("Message", "").replace("DocumentWithCaption", "document"));
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}

async function handleMessage(m) {
  const jid = m.key.remoteJid;
  const isGroup = jid.endsWith("@g.us");
  const text = getText(m);
  if (!text) return;

  // identitas pengirim
  let senderJid = isGroup ? m.key.participant : jid;
  senderJid = senderJid.split(":")[0].split("@")[0]; // nomor saja
  const senderTag = `+${senderJid}`;

  const cmd = text.toLowerCase();
  const fromOwner = data.owner && senderJid === data.owner;

  // ===== VERIFIKASI OWNER =====
  if (cmd === "/verify") {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const sendJid = isGroup ? m.key.participant : jid; // jid penuh untuk kirim balasan
    pendingVerify = { code, userJid: senderJid, sendJid, userName: senderTag, expires: Date.now() + 3 * 60 * 1000 };
    console.log("\n========================================");
    console.log(`[!] PERMINTAAN VERIFIKASI OWNER`);
    console.log(`    Dari   : ${senderTag}`);
    console.log(`    Kode   : ${code} (berlaku 3 menit)`);
    console.log(`    Ketik kode di bawah untuk konfirmasi:`);
    console.log("========================================");
    await sock.sendMessage(jid, { text: `🔐 Kode verifikasi kamu: *${code}*\n\nMasukkan kode ini di terminal server untuk konfirmasi.\nBerlaku 3 menit.` });
    return;
  }

  if (cmd === "/owner") {
    await sock.sendMessage(jid, {
      text: data.owner
        ? (fromOwner ? "👑 Kamu adalah owner." : `Owner bot: +${data.owner}`)
        : "Belum ada owner. Kirim /verify untuk mendaftar.",
    });
    return;
  }

  // ===== RESTART BOT (khusus owner, dari mana saja) =====
  if (cmd === "/reboot") {
    if (!fromOwner) {
      await sock.sendMessage(jid, { text: "❌ Hanya owner yang bisa me-restart bot." });
      return;
    }
    await sock.sendMessage(jid, { text: "♻️ Bot sedang di-restart...\nKode terbaru akan dimuat setelah bot kembali online." });
    setTimeout(() => rebootFn(), rebootDelay);
    return;
  }

  // ===== AKTIVASI GRUP (khusus owner) =====
  if (cmd === "/allow" || cmd === "/deny") {
    if (!fromOwner) {
      await sock.sendMessage(jid, { text: "❌ Hanya owner yang bisa menggunakan perintah ini." });
      return;
    }
    if (!isGroup) {
      await sock.sendMessage(jid, { text: "⚠️ Perintah ini hanya bisa dipakai di dalam grup." });
      return;
    }
    const meta = await sock.groupMetadata(jid);
    if (cmd === "/allow") {
      if (!data.allowedGroups.includes(jid)) {
        data.allowedGroups.push(jid);
        saveData();
      }
      await sock.sendMessage(jid, { text: `✅ Bot *AKTIF* di grup *${meta.subject}*!\n\n🎮 Perintah:\n• /start — mulai game ping-pong\n• pong — pukul bolanya!\n• /score — lihat skor\n• /stop — hentikan game` });
    } else {
      data.allowedGroups = data.allowedGroups.filter((g) => g !== jid);
      games.delete(jid);
      saveData();
      await sock.sendMessage(jid, { text: `🔴 Bot *NONAKTIF* di grup *${meta.subject}*.` });
    }
    return;
  }

  // ===== Semua perintah di bawah hanya aktif di grup yang diizinkan =====
  if (!isGroup || !data.allowedGroups.includes(jid)) return;

  // ===== COMMAND MODULAR (/menu, /react, /qr, /s, dst.) =====
  const ctx = { sock, m, jid, text: cmd, senderTag, fromOwner, data, downloadMedia };
  for (const c of commands) {
    if (c.match(cmd)) {
      await c.handler(ctx);
      return;
    }
  }

  // ----- GAME PING-PONG -----
  if (cmd === "/start") {
    const g = games.get(jid);
    if (g && g.rally > 0) {
      await sock.sendMessage(jid, { text: "⚠️ Game masih berjalan! Kirim *pong* untuk memukul, atau /stop." });
      return;
    }
    games.set(jid, { ball: 0, rally: 0, active: true, scores: {} });
    await sock.sendMessage(jid, {
      text: `🏓 *GAME PING-PONG DIMULAI!*\n\nBola dilambungkan... 🎾\nSiapa cepat, kirim *pong* untuk memukul!\nKesempatan gagal: 25% per pukulan.`,
    });
    return;
  }

  if (cmd === "/stop") {
    if (games.has(jid)) {
      games.delete(jid);
      await sock.sendMessage(jid, { text: "🛑 Game dihentikan. Skor tetap tersimpan, /score untuk melihat." });
    }
    return;
  }

  if (cmd === "/score") {
    const g = games.get(jid);
    if (!g || Object.keys(g.scores).length === 0) {
      await sock.sendMessage(jid, { text: "📊 Belum ada skor. Mulai game dengan /start!" });
      return;
    }
    const list = Object.entries(g.scores)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([num, p], i) => `${i + 1}. ${p.name} — ${p.score} poin`)
      .join("\n");
    await sock.sendMessage(jid, { text: `🏆 *PAPAN SKOR*\n\n${list}` });
    return;
  }

  if (cmd === "pong" || cmd === "ping") {
    const g = games.get(jid);
    if (!g || !g.active) {
      // belum ada game aktif -> jawaban ping-pong biasa
      if (cmd === "ping") {
        await sock.sendMessage(jid, { text: "🏓 pong!" });
      }
      return;
    }
    // pemain memukul bola
    const name = m.pushName || senderTag;
    g.rally++;
    const miss = Math.random() < 0.25 && g.rally > 2;
    if (miss) {
      const score = Math.floor(g.rally / 2);
      g.scores[senderJid] = g.scores[senderJid] || { name, score: 0 };
      g.scores[senderJid].score += score;
      games.set(jid, g);
      await sock.sendMessage(jid, {
        text: `💥 *BOLA LEWAT!* ${name} gagal memukul!\n🔥 Rally: ${g.rally - 1} pukulan\n➕ ${name} dapat ${score} poin (total ${g.scores[senderJid].score})\n\nKirim *pong* untuk ronde baru!`,
      });
      g.rally = 0;
      return;
    }
    g.ball++;
    const tricks = ["🏓", "🎾", "⚡", "💨", "🔥"];
    await sock.sendMessage(jid, { text: `${tricks[Math.floor(Math.random() * tricks.length)]} *POK!* rally ke-${g.rally} oleh ${name}` });
    return;
  }
}

module.exports = {
  handleMessage,
  handleCodeInput,
  startBot,
  initReadline,
  getPendingVerify: () => pendingVerify,
  setPendingVerify: (v) => { pendingVerify = v; },
  getData: () => data,
  setData: (d) => { data = d; saveData(); },
  resetData: () => { data = { owner: null, allowedGroups: [] }; saveData(); },
  setSock: (s) => { sock = s; },
  games,
  setReboot: (fn) => { rebootFn = fn; },
  setRebootDelay: (ms) => { rebootDelay = ms; },
  realReboot,
};

if (require.main === module) {
  console.log("[*] Memulai WA Ping-Pong Bot (Baileys)...");
  initReadline();
  startBot();
}
