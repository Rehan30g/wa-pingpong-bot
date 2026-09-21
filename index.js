require("dotenv").config({ quiet: true });

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
const groupAgent = require("./ai/group-agent");
const directAgent = require("./ai/direct-agent");
const memoryStore = require("./ai/memory-store");
const scheduler = require("./ai/scheduler");

const DATA_FILE = process.env.BOT_DATA_FILE || "./data.json";
let data = { owner: null, allowedGroups: [], vetoAccess: {} };
if (fs.existsSync(DATA_FILE)) {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
}
function normalizeDataShape(value = {}) {
  return {
    ...value,
    owner: value.owner || null,
    allowedGroups: Array.isArray(value.allowedGroups) ? value.allowedGroups : [],
    vetoAccess: value.vetoAccess && typeof value.vetoAccess === "object" && !Array.isArray(value.vetoAccess)
      ? value.vetoAccess
      : {},
  };
}
data = normalizeDataShape(data);
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
let presenceKeepAlive = null;
const groupMetadataCache = new Map();
const GROUP_METADATA_TTL_MS = 60_000;

// Jaga status bot tetap "online": presence available dikirim ulang berkala.
function startPresenceKeepAlive() {
  clearInterval(presenceKeepAlive);
  presenceKeepAlive = setInterval(async () => {
    try {
      await sock?.sendPresenceUpdate("available");
    } catch (error) {
      console.warn("[i] Gagal kirim presence available:", error.message);
    }
  }, 4 * 60_000);
}

function stopPresenceKeepAlive() {
  clearInterval(presenceKeepAlive);
  presenceKeepAlive = null;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["PingPong Bot", "Chrome", "1.0.0"],
    // Bot terlihat online supaya receipt "delivered" aktif:
    // pesan pengguna mendapat centang abu-abu begitu diterima bot.
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates || []) groupMetadataCache.delete(update.id);
  });
  sock.ev.on("group-participants.update", ({ id }) => groupMetadataCache.delete(id));

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n[*] Scan QR ini dengan WhatsApp (Perangkat Tertaut):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("[+] Bot terhubung!");
      console.log("[i] Kirim /verify dari WhatsApp untuk menjadi owner.");
      startPresenceKeepAlive();
      scheduler.start({ sock });
    }
    if (connection === "close") {
      stopPresenceKeepAlive();
      scheduler.stop();
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

// Buka pembungkus viewOnceMessage/viewOnceMessageV2 (foto/video "sekali lihat").
function unwrapMediaWrappers(message) {
  let current = message;
  while (current) {
    const wrapper = current.viewOnceMessage || current.viewOnceMessageV2;
    if (!wrapper?.message || wrapper.message === current) break;
    current = wrapper.message;
  }
  return current || message;
}

function getText(m) {
  const content = unwrapMediaWrappers(m.message) || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ""
  ).trim();
}

function isPhoneJid(value) {
  return /@(s\.whatsapp\.net|c\.us)$/i.test(String(value || ""));
}

function normalizeJid(jid = "") {
  return String(jid).split(":")[0].split("@")[0];
}

function normalizePhoneNumber(value = "") {
  const digits = normalizeJid(value).replace(/\D/g, "");
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  return digits;
}

function identitiesMatch(left, right) {
  const a = normalizeJid(left);
  const b = normalizeJid(right);
  if (!a || !b) return false;
  return a === b || normalizePhoneNumber(a) === normalizePhoneNumber(b);
}

function messageSenderIdentities(m, isGroup, chatJid) {
  const candidates = isGroup
    ? [
      m.key?.participantPn,
      m.key?.senderPn,
      m.key?.participantAlt,
      m.key?.senderAlt,
      m.key?.participant,
    ]
    : [m.key?.senderPn, m.key?.senderAlt, m.key?.remoteJidAlt, chatJid];
  return [...new Set(candidates.map(normalizeJid).filter(Boolean))];
}

function getSenderNumber(m, isGroup, chatJid) {
  const candidates = isGroup
    ? [m.key?.participantPn, m.key?.senderPn, m.key?.participantAlt, m.key?.senderAlt, m.key?.participant, chatJid]
    : [m.key?.senderPn, m.key?.senderAlt, m.key?.remoteJidAlt, chatJid];
  const phoneJid = candidates.find((value) => /@(s\.whatsapp\.net|c\.us)$/i.test(String(value || "")));
  return normalizeJid(phoneJid || candidates.find(Boolean) || "");
}

function phoneIdentity(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.startsWith("62")) return `+${digits} (0${digits.slice(2)})`;
  return digits ? `+${digits}` : "nomor-tidak-diketahui";
}

async function sendTextChunks(jid, text, maxLength = 3_500) {
  const value = String(text || "");
  for (let offset = 0; offset < value.length; offset += maxLength) {
    await sock.sendMessage(jid, { text: value.slice(offset, offset + maxLength) });
  }
}

function getContextInfo(m) {
  return (
    m.message?.extendedTextMessage?.contextInfo ||
    m.message?.imageMessage?.contextInfo ||
    m.message?.videoMessage?.contextInfo ||
    {}
  );
}

function getQuotedText(m) {
  const quoted = unwrapMediaWrappers(getContextInfo(m).quotedMessage);
  if (!quoted) return "";
  return (
    quoted.conversation ||
    quoted.extendedTextMessage?.text ||
    quoted.imageMessage?.caption ||
    quoted.videoMessage?.caption ||
    ""
  ).trim();
}

// WhatsApp menulis tag di teks sebagai nomor (mis. "@628xxx" atau "@<lid>").
// Ubah menjadi nama dengan "@" agar AI mengenali tag bot sebagai nama bot.
// Nomor di teks bisa berupa PN sedangkan mentionedJid berupa LID, jadi semua
// alias peserta dicoba.
function mentionTokens(jid, metadata) {
  const normalized = normalizeJid(jid);
  if (!normalized) return null;
  if (botIdentities().includes(normalized)) {
    return { aliases: botIdentities(), display: groupAgent.config().botName };
  }
  const participant = metadata ? participantForIdentity(metadata, jid) : null;
  const aliases = participant ? participantIdentities(participant) : [normalized];
  const display = participant?.name || participant?.notify || aliases[0] || normalized;
  return { aliases: [...new Set([normalized, ...aliases].filter(Boolean))], display };
}

function decorateMentions(text, contextInfo, metadata) {
  let value = String(text || "");
  for (const jid of contextInfo?.mentionedJid || []) {
    const tokens = mentionTokens(jid, metadata);
    if (!tokens?.display) continue;
    for (const alias of tokens.aliases) {
      const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`@${escaped}(?::\\d+)?(?![\\d])`, "g"), `@${tokens.display}`);
    }
  }
  return value;
}

function botIdentities() {
  return [...new Set([normalizeJid(sock?.user?.id), normalizeJid(sock?.user?.lid)].filter(Boolean))];
}

function isReplyToBot(contextInfo) {
  if (!contextInfo?.quotedMessage) return false;
  const quotedParticipant = normalizeJid(contextInfo.participant);
  return Boolean(quotedParticipant && botIdentities().includes(quotedParticipant));
}

// ---- helper download media (untuk stiker dll) ----
function mediaFileLength(message) {
  const value = message?.fileLength;
  if (value == null) return null;
  try {
    const bytes = typeof value?.toNumber === "function" ? value.toNumber() : Number(value);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

function participantIdentities(participant = {}) {
  return [...new Set([
    participant.id,
    participant.lid,
    participant.jid,
    participant.phoneNumber,
    participant.pn,
  ].map(normalizeJid).filter(Boolean))];
}

async function getGroupMetadataSafe(groupId) {
  const cached = groupMetadataCache.get(groupId);
  if (cached && Date.now() - cached.at < GROUP_METADATA_TTL_MS) return cached.value;
  try {
    const value = await sock.groupMetadata(groupId);
    groupMetadataCache.set(groupId, { at: Date.now(), value });
    return value;
  } catch (error) {
    console.warn("[i] Gagal membaca admin grup:", error.message);
    return null;
  }
}

function participantForIdentity(metadata, identity) {
  const normalized = normalizeJid(identity);
  return metadata?.participants?.find((participant) => participantIdentities(participant).includes(normalized));
}

function participantForIdentities(metadata, identities) {
  return metadata?.participants?.find((participant) => {
    const aliases = participantIdentities(participant);
    return identities.some((identity) => aliases.some((alias) => identitiesMatch(alias, identity)));
  });
}

function canonicalParticipantIdentity(participant, fallback = "") {
  if (!participant) return normalizeJid(fallback);
  const phone = [participant.jid, participant.phoneNumber, participant.pn, participant.id]
    .find((value) => /@(s\.whatsapp\.net|c\.us)$/i.test(String(value || "")) || /^\+?\d{8,15}$/.test(String(value || "")));
  return normalizeJid(phone || fallback || participant.id || participant.lid);
}

function isAdminParticipant(metadata, senderId) {
  const participant = participantForIdentity(metadata, senderId);
  return participant?.admin === "admin" || participant?.admin === "superadmin";
}

function groupVetoUsers(groupId) {
  const users = data.vetoAccess?.[groupId];
  return Array.isArray(users) ? users : [];
}

function resolveVetoTarget(m, commandText, metadata) {
  const context = getContextInfo(m);
  const argument = commandText.split(/\s+/).slice(1).join("").replace(/^@/, "");
  const numericArgument = /^\+?\d{8,15}$/.test(argument) ? argument : "";
  const candidates = [
    context.participantPn,
    context.senderPn,
    context.participant,
    ...(context.mentionedJid || []),
    numericArgument,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const participant = participantForIdentity(metadata, candidate);
    const resolved = canonicalParticipantIdentity(participant, candidate);
    if (resolved) return resolved;
  }
  return "";
}

async function collectMediaStream(stream, { maxBytes = Infinity } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`Media melebihi batas ${(maxBytes / 1_048_576).toFixed(1)}MB`);
      error.code = "AI_MEDIA_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function downloadMedia(m, { maxBytes = Infinity } = {}) {
  const msg = unwrapMediaWrappers(m.message) || {};
  const type = getContentType(msg);
  if (!msg[type] || !(msg[type].url || msg[type].directPath)) return null;
  const stream = await downloadContentFromMessage(msg[type], type.replace("Message", "").replace("DocumentWithCaption", "document"));
  return collectMediaStream(stream, { maxBytes });
}

// Unduh gambar/video (langsung atau yang dikutip) sebagai data URL untuk GLM multimodal.
function maxMediaBytes() {
  return Math.max(1, Number(process.env.AI_MAX_MEDIA_MB || 20)) * 1_048_576;
}

function classifyAiMedia({ type, kind, format, msg } = {}) {
  const isGif = type === "video" && Boolean(msg?.gifPlayback);
  return {
    kind: kind || (isGif ? "sticker" : "attachment"),
    format: format || (isGif ? "gif" : type),
  };
}

async function getAiMedia(m) {
  try {
    const direct = unwrapMediaWrappers(m.message) || {};
    const quoted = unwrapMediaWrappers(getContextInfo(m)?.quotedMessage) || {};
    const candidates = [
      direct.imageMessage && { type: "image", msg: direct.imageMessage, source: m },
      direct.videoMessage && { type: "video", msg: direct.videoMessage, source: m },
      direct.stickerMessage && { type: "image", kind: "sticker", format: "webp", msg: direct.stickerMessage, source: m },
      quoted?.imageMessage && { type: "image", msg: quoted.imageMessage, source: { message: { imageMessage: quoted.imageMessage } } },
      quoted?.videoMessage && { type: "video", msg: quoted.videoMessage, source: { message: { videoMessage: quoted.videoMessage } } },
      quoted?.stickerMessage && { type: "image", kind: "sticker", format: "webp", msg: quoted.stickerMessage, source: { message: { stickerMessage: quoted.stickerMessage } } },
    ].filter(Boolean);
    // WhatsApp modern kadang hanya mengirim directPath tanpa url; keduanya bisa diunduh.
    const media = candidates.find((candidate) => candidate.msg?.url || candidate.msg?.directPath);
    if (!media) return null;
    const limit = maxMediaBytes();
    const declaredLength = mediaFileLength(media.msg);
    if (declaredLength != null && declaredLength > limit) {
      console.warn(`[AI] Media ${(declaredLength / 1_048_576).toFixed(1)}MB melebihi batas, tidak diunduh`);
      return null;
    }
    const buffer = await downloadMedia(media.source, { maxBytes: limit });
    if (!buffer?.length) return null;
    const { kind, format } = classifyAiMedia(media);
    const mime = media.type === "video"
      ? (String(media.msg.mimetype || "").startsWith("video/") ? media.msg.mimetype : "video/mp4")
      : (media.msg.mimetype || (kind === "sticker" ? "image/webp" : "image/jpeg"));
    return { type: media.type, kind, format, dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
  } catch (error) {
    console.warn("[AI] Gagal mengunduh media:", error.message);
    return null;
  }
}

async function handleMessage(m) {
  const jid = m.key.remoteJid;
  const isGroup = jid.endsWith("@g.us");
  const text = getText(m);
  const isAllowedGroup = isGroup && data.allowedGroups.includes(jid);
  let earlyMedia = null;
  if (!text) {
    // Media tanpa caption tetap diproses AI (GLM multimodal), baik di grup
    // yang diizinkan maupun di chat pribadi; media lain dibuang.
    if (isGroup && !isAllowedGroup) return;
    earlyMedia = await getAiMedia(m);
    if (!earlyMedia) return;
  }

  // identitas pengirim
  let senderJid = getSenderNumber(m, isGroup, jid);
  let senderTag = phoneIdentity(senderJid);

  const cmd = text.toLowerCase();
  const senderIdentities = messageSenderIdentities(m, isGroup, jid);
  let senderPhoneVerified = isGroup
    ? [m.key?.participantPn, m.key?.senderPn, m.key?.participantAlt, m.key?.senderAlt, m.key?.participant].some(isPhoneJid)
    : [m.key?.senderPn, m.key?.senderAlt, m.key?.remoteJidAlt, jid].some(isPhoneJid);
  let metadataCache;
  let senderParticipant;
  let fromOwner = Boolean(data.owner && senderIdentities.some((identity) => identitiesMatch(identity, data.owner)));
  const loadSenderMetadata = async () => {
    if (!isGroup) return null;
    if (metadataCache === undefined) metadataCache = await getGroupMetadataSafe(jid);
    senderParticipant ||= participantForIdentities(metadataCache, senderIdentities);
    const canonical = canonicalParticipantIdentity(senderParticipant, senderJid);
    if (senderParticipant && [senderParticipant.jid, senderParticipant.phoneNumber, senderParticipant.pn].some(isPhoneJid)) {
      senderPhoneVerified = true;
    }
    if (canonical) {
      senderJid = canonical;
      if (data.owner && identitiesMatch(canonical, data.owner)) fromOwner = true;
    }
    return metadataCache;
  };

  // Pada grup mode LID, nomor PN tersedia lewat participantAlt atau field `jid`
  // di metadata peserta. Resolusi dilakukan untuk semua pesan grup aktif agar
  // riwayat Jev/GLM menyimpan nomor, bukan LID.
  if (isGroup && (cmd.startsWith("/") || isAllowedGroup)) {
    await loadSenderMetadata();
    senderTag = phoneIdentity(senderJid);
  }

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

  // ===== KONTROL AGEN (khusus owner) =====
  if (cmd === "/agent" || cmd.startsWith("/agent ")) {
    if (!fromOwner) {
      await sock.sendMessage(jid, { text: "❌ Hanya owner yang bisa mengatur agen." });
      return;
    }
    const arg = cmd.split(/\s+/)[1] || "status";
    if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      scheduler.setEnabled(enabled);
      if (enabled) scheduler.start({ sock });
    } else if (arg === "clear") {
      scheduler.clearJobs();
    }
    const state = scheduler.status();
    await sock.sendMessage(jid, {
      text: [
        "🤖 *STATUS AGEN GRAD*",
        `Aktif: ${state.enabled ? "ya" : "tidak"}`,
        `DM proaktif: ${state.proactive ? "boleh" : "tidak"}`,
        `Job menunggu: ${state.jobs}`,
        `DM proaktif hari ini: ${state.proactiveToday}/${state.dailyLimit}`,
        `Jam tenang: ${state.quiet ? "ya (bot tidak memulai DM)" : "tidak"}`,
        "",
        "Perintah: /agent on, /agent off, /agent clear, /agent status",
      ].join("\n"),
    });
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
    const meta = metadataCache || await sock.groupMetadata(jid);
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

// ===== CHAT PRIBADI (DM) =====
  if (!isGroup) {
    // Perintah tidak dikenal di DM diabaikan; media tanpa caption tetap diproses.
    if (text.startsWith("/")) return;
    const dmMedia = earlyMedia || (await getAiMedia(m));
    if (!text && !dmMedia) return;
    await directAgent.processDirectMessage({
      sock,
      message: m,
      phone: senderJid,
      senderName: m.pushName || senderTag,
      text: text || (dmMedia?.kind === "sticker" ? "[mengirim stiker]" : dmMedia?.type === "video" ? "[mengirim video]" : "[mengirim gambar]"),
      quotedText: getQuotedText(m),
      media: dmMedia,
      isOwner: fromOwner,
    });
    return;
  }

  // ===== Semua perintah di bawah hanya aktif di grup yang diizinkan =====
  if (!data.allowedGroups.includes(jid)) return;

  // Owner dapat memberi hak pengelolaan konteks kepada anggota tertentu.
  if (cmd === "/veto list" || cmd === "/veto" || cmd.startsWith("/veto ") || cmd === "/unveto" || cmd.startsWith("/unveto ")) {
    if (!fromOwner) {
      await sock.sendMessage(jid, { text: "Hanya owner yang bisa memberi atau mencabut akses veto." });
      return;
    }
    if (cmd === "/veto list") {
      const users = groupVetoUsers(jid);
      await sock.sendMessage(jid, { text: users.length ? `Akses veto grup:\n${users.map((id) => `• ${phoneIdentity(id)}`).join("\n")}` : "Belum ada anggota dengan akses veto di grup ini." });
      return;
    }
    const metadata = await loadSenderMetadata();
    const target = resolveVetoTarget(m, cmd, metadata);
    if (!target) {
      await sock.sendMessage(jid, { text: "Reply pesan anggota atau gunakan /veto 628xxx. Untuk mencabut: /unveto 628xxx." });
      return;
    }
    const users = new Set(groupVetoUsers(jid));
    if (cmd.startsWith("/unveto")) users.delete(target);
    else users.add(target);
    data.vetoAccess[jid] = [...users];
    saveData();
    await sock.sendMessage(jid, {
      text: cmd.startsWith("/unveto")
        ? `Akses veto ${phoneIdentity(target)} sudah dicabut.`
        : `Akses veto ${phoneIdentity(target)} sudah diberikan.`,
    });
    return;
  }

  // ===== MANAJEMEN KONTEKS AI =====
  if (cmd === "/clear" || cmd === "/reset" || cmd === "/memory") {
    const vetoCandidates = [...senderIdentities, senderJid];
    const hasVeto = groupVetoUsers(jid).some((allowed) => vetoCandidates.some((identity) => identitiesMatch(allowed, identity)));
    const metadata = fromOwner || hasVeto ? metadataCache : await loadSenderMetadata();
    const fromGroupAdmin = metadata
      ? Boolean(senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin" || isAdminParticipant(metadata, senderJid))
      : false;
    if (!fromOwner && !hasVeto && !fromGroupAdmin) {
      await sock.sendMessage(jid, { text: "Hanya owner, admin grup, atau anggota dengan akses veto yang bisa mengelola memori Grad." });
      return;
    }
  }

  if (cmd === "/clear") {
    groupAgent.clearConversation(jid);
    await sock.sendMessage(jid, { text: "Percakapan aktif sudah dibersihkan. Memori compact tetap disimpan." });
    return;
  }

  if (cmd === "/reset") {
    groupAgent.resetGroupContext(jid);
    await sock.sendMessage(jid, { text: "Konteks percakapan dan seluruh memori Grad untuk grup ini sudah direset." });
    return;
  }

  if (cmd === "/memory") {
    await sendTextChunks(jid, groupAgent.getMemoryDisplay(jid));
    return;
  }

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

  // ----- AI GROUP AGENT -----
  // Jev memilih diam/react/jawab; GLM hanya dipanggil untuk menulis jawaban.
  const aiMedia = earlyMedia || (await getAiMedia(m));
  if (!text && !aiMedia) return;
  const contextInfo = getContextInfo(m);
  const mentioned = (contextInfo.mentionedJid || []).map(normalizeJid);
  const metadataMention = Boolean(botIdentities().some((id) => mentioned.includes(id)));
  const nameMention = groupAgent.textMentionsBotName(text);
  const explicitMention = metadataMention || nameMention;
  const replyToBot = isReplyToBot(contextInfo);
  const decoratedText = decorateMentions(text, contextInfo, metadataCache);
  const decoratedQuoted = decorateMentions(getQuotedText(m), contextInfo, metadataCache);

  // Catat orang yang pernah aktif di grup agar Grad mengenalnya dan boleh
  // membalas/ memulai DM hanya kepada mereka.
  if (senderPhoneVerified) {
    memoryStore.recordParticipant({ phone: senderJid, name: m.pushName || senderTag, groupId: jid, at: groupAgent.witTimestamp() });
  } else {
    console.warn(`[AI] PN pengirim belum terverifikasi; LID tidak dimasukkan whitelist DM (${senderJid})`);
  }

  await groupAgent.processGroupMessage({
    sock,
    message: m,
    groupId: jid,
    senderId: senderPhoneVerified ? senderJid : "nomor-tidak-diketahui",
    senderName: m.pushName || senderTag,
    text: decoratedText || (aiMedia?.kind === "sticker" ? "[mengirim stiker]" : aiMedia?.type === "video" ? "[mengirim video]" : "[mengirim gambar]"),
    explicitMention,
    replyToBot,
    media: aiMedia,
    quotedText: decoratedQuoted,
  });
}

module.exports = {
  handleMessage,
  handleCodeInput,
  startBot,
  initReadline,
  getPendingVerify: () => pendingVerify,
  getSenderNumber,
  phoneIdentity,
  setPendingVerify: (v) => { pendingVerify = v; },
  getData: () => data,
  setData: (d) => { data = normalizeDataShape(d); saveData(); },
  isReplyToBot,
  botIdentities,
  collectMediaStream,
  classifyAiMedia,
  mediaFileLength,
  unwrapMediaWrappers,
  resetData: () => { data = { owner: null, allowedGroups: [], vetoAccess: {} }; groupMetadataCache.clear(); saveData(); },
  setSock: (s) => { sock = s; groupMetadataCache.clear(); },
  games,
  setReboot: (fn) => { rebootFn = fn; },
  setRebootDelay: (ms) => { rebootDelay = ms; },
  realReboot,
  groupAgent,
  directAgent,
  memoryStore,
  scheduler,
};

if (require.main === module) {
  console.log("[*] Memulai WA Ping-Pong Bot (Baileys)...");
  console.log(groupAgent.isConfigured()
    ? `[AI] Aktif: ${groupAgent.config().jevModel} -> ${groupAgent.config().chatModel}`
    : "[AI] Nonaktif: ganti OPENROUTER_API_KEY di file .env");
  initReadline();
  startBot();
}
