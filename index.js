require("dotenv").config({ quiet: true });
// Pengaturan runtime dari dashboard owner menimpa nilai .env (bukan secret).
require("./ai/runtime-settings").applySavedSettings();

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
const { extractVideoFrame } = require("./ai/media/video-frame");
const { initGlobalLifecycle, getGlobalLifecycle } = require("./ai/runtime/lifecycle");
const { getStickerCollector, stickerSha } = require("./ai/stickers/collector");
const { getStickerLibrary } = require("./ai/stickers/library");
const { handleStickerCommand } = require("./ai/stickers/commands");
const stickerCurator = require("./ai/stickers/curator");
const { processVoiceNote } = require("./ai/audio/voice-notes");
const agentUsage = require("./ai/agent/usage");
const featureSettings = require("./ai/features");
const proactiveState = require("./ai/agent/proactive");
const { handleFeatureCommand } = require("./ai/features-commands");
const { formatDuration } = require("./ai/audio/ears");

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
let connectionOpen = false;
const startedAt = Date.now();
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

async function initRuntime(options = {}) {
  return initGlobalLifecycle({ sock, ...options });
}

async function shutdownRuntime() {
  const lifecycle = getGlobalLifecycle();
  if (lifecycle) {
    await lifecycle.shutdown();
  }
}

async function startBot() {
  await initRuntime({ sock });
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

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n[*] Scan QR ini dengan WhatsApp (Perangkat Tertaut):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      connectionOpen = true;
      console.log("[+] Bot terhubung!");
      console.log("[i] Kirim /verify dari WhatsApp untuk menjadi owner.");
      startPresenceKeepAlive();
      stickerCurator.startCurationScheduler();
      const lifecycle = getGlobalLifecycle();
      if (lifecycle) {
        await lifecycle.onTransportReady({ sock });
      } else {
        scheduler.start({ sock });
      }
    }
    if (connection === "close") {
      connectionOpen = false;
      stopPresenceKeepAlive();
      stickerCurator.stopCurationScheduler();
      const lifecycle = getGlobalLifecycle();
      if (lifecycle) {
        await lifecycle.onTransportClosed();
      } else {
        scheduler.stop();
      }
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[!] Koneksi terputus (code=${code}, reason=${DisconnectReason[code] ?? lastDisconnect?.error?.message})`);
      if (code === DisconnectReason.loggedOut) {
        console.log("[!] Ter-logout. Hapus folder auth dan scan ulang.");
        await shutdownRuntime();
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
        await dispatchInboundMessage(m, { sock });
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
    m.message?.audioMessage?.contextInfo ||
    m.message?.stickerMessage?.contextInfo ||
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

async function getGroupMetadataSafe(groupId, customSock = null) {
  const cached = groupMetadataCache.get(groupId);
  if (cached && Date.now() - cached.at < GROUP_METADATA_TTL_MS) return cached.value;
  const active = customSock || sock;
  if (!active || typeof active.groupMetadata !== "function") return null;
  try {
    const value = await active.groupMetadata(groupId);
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

// Unduh media langsung atau kutipan; video dikonversi menjadi satu frame gambar.
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

// Media asli (bukan frame) dari pesan atau pesan yang di-reply, untuk media_edit.
async function getRawMedia(m, { maxBytes = 64 * 1_048_576 } = {}) {
  const direct = unwrapMediaWrappers(m?.message) || {};
  const quoted = unwrapMediaWrappers(getContextInfo(m || {})?.quotedMessage) || {};
  const pick = (content) => {
    if (content.videoMessage) return { type: "videoMessage", msg: content.videoMessage, kind: content.videoMessage.gifPlayback ? "gif" : "video", ext: "mp4" };
    if (content.stickerMessage) return { type: "stickerMessage", msg: content.stickerMessage, kind: "sticker", ext: "webp" };
    if (content.imageMessage) return { type: "imageMessage", msg: content.imageMessage, kind: "image", ext: "jpg" };
    if (content.audioMessage) return { type: "audioMessage", msg: content.audioMessage, kind: "audio", ext: "ogg" };
    const doc = content.documentMessage;
    if (doc && /^(video|audio|image)\//.test(doc.mimetype || "")) return { type: "documentMessage", msg: doc, kind: doc.mimetype.split("/")[0], ext: (doc.fileName || "").split(".").pop() || "bin" };
    return null;
  };
  const media = pick(direct) || pick(quoted);
  if (!media || !(media.msg.url || media.msg.directPath)) return null;
  const declared = mediaFileLength(media.msg);
  if (declared != null && declared > maxBytes) throw new Error("media lebih dari 64 MB");
  const buffer = await downloadMedia({ message: { [media.type]: media.msg } }, { maxBytes });
  return buffer?.length ? { buffer, kind: media.kind, ext: media.ext.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin" } : null;
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
    if (media.type === "video") {
      const frame = await extractVideoFrame(buffer);
      return {
        type: "video", kind, format,
        durationSeconds: Number(media.msg.seconds) || null,
        frameDataUrl: frame ? `data:image/jpeg;base64,${frame.toString("base64")}` : null,
      };
    }
    const mime = media.type === "video"
      ? (String(media.msg.mimetype || "").startsWith("video/") ? media.msg.mimetype : "video/mp4")
      : (media.msg.mimetype || (kind === "sticker" ? "image/webp" : "image/jpeg"));
    return { type: media.type, kind, format, dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
  } catch (error) {
    console.warn("[AI] Gagal mengunduh media:", error.message);
    return null;
  }
}

// get_chat_media mengunduh ulang media pesan lama yang sudah dibuang dari riwayat.
groupAgent.setMediaLoader(getAiMedia);
groupAgent.setRawMediaLoader(getRawMedia);
// save_sticker mengunduh stiker yang di-reply bila belum pernah terkumpul.
groupAgent.setStickerDownloader((stickerMessage) => downloadMedia({ message: { stickerMessage } }, { maxBytes: 2 * 1_048_576 }));

// Voice note langsung dan yang di-reply → teks transkrip + mp3 untuk listen_audio.
async function readVoiceNotes(m, { jid, isGroup, senderJid }) {
  if (!groupAgent.isConfigured()) return null;
  const direct = unwrapMediaWrappers(m.message)?.audioMessage || null;
  const contextInfo = getContextInfo(m);
  const quoted = unwrapMediaWrappers(contextInfo.quotedMessage)?.audioMessage || null;
  if (!direct && !quoted) return null;
  // Fitur "audio" mati: voice note tidak dikirim ke model audio sama sekali.
  if (!featureSettings.isEnabled(isGroup ? jid : `${memoryStore.normalizePhone(senderJid)}@s.whatsapp.net`, "audio")) {
    const label = (audio) => `[${audio.ptt === false ? "audio" : "voice note"} ${formatDuration(audio.seconds)}]`;
    return { direct: direct ? { text: label(direct), audio: null } : null, quoted: quoted ? { text: label(quoted), audio: null } : null };
  }
  const chatKey = isGroup ? jid : directAgent.dmKey(senderJid);
  const recentHistory = groupAgent.getHistory(chatKey);
  const context = {
    botName: groupAgent.config().botName,
    participants: [...new Set(recentHistory.filter((item) => !item.is_bot).map((item) => item.sender))],
    recent: recentHistory.slice(-5).map((item) => `[${item.sender}] ${item.text}`),
  };
  const read = (audioMessage, messageId) => processVoiceNote({
    audioMessage,
    messageId,
    context,
    download: () => downloadMedia({ message: { audioMessage } }, { maxBytes: Math.max(1, Number(process.env.AI_MAX_AUDIO_MB) || 16) * 1_048_576 }),
  });
  return {
    direct: direct ? await read(direct, m.key?.id) : null,
    quoted: quoted ? await read(quoted, contextInfo.stanzaId) : null,
  };
}

// Grup aktif bot beserta status admin pengirim, dibaca langsung dari WhatsApp
// (tanpa cache) supaya admin yang baru dicabut tidak bisa mengubah fitur.
async function adminGroupsFor(identities, activeSock = sock) {
  const groups = [];
  for (const groupId of data.allowedGroups) {
    let metadata = null;
    try {
      metadata = await activeSock?.groupMetadata?.(groupId);
    } catch (error) {
      console.warn("[FITUR] Gagal membaca metadata grup:", error.message);
    }
    if (metadata) groupMetadataCache.set(groupId, { at: Date.now(), value: metadata });
    const participant = participantForIdentities(metadata, identities);
    groups.push({
      id: groupId,
      subject: metadata?.subject || groupId,
      admin: participant?.admin === "admin" || participant?.admin === "superadmin",
    });
  }
  return groups;
}

// Pengumpulan stiker (Plan v2 §4a): hanya grup yang diizinkan dan DM yang
// di-whitelist. Berjalan di latar supaya tidak menunda balasan.
function observeStickerTraffic({ m, jid, isGroup, isAllowedGroup, text, senderJid, senderTag, senderPhoneVerified }) {
  if (isGroup ? !isAllowedGroup : !memoryStore.canDirectMessage(senderJid)) return;
  // DM dicatat memakai JID nomor (bukan LID) agar cocok dengan tujuan kirim Grad.
  const chatId = isGroup || !senderPhoneVerified ? jid : `${memoryStore.normalizePhone(senderJid)}@s.whatsapp.net`;
  if (!featureSettings.isEnabled(chatId, "stiker")) return;
  const sticker = unwrapMediaWrappers(m.message)?.stickerMessage || null;
  if (!sticker && (!text || /^[/!]/.test(text))) return;
  getStickerCollector().observe({
    chatId,
    isDm: !isGroup,
    senderId: senderPhoneVerified ? senderJid : null,
    senderName: m.pushName || senderTag,
    text,
    sticker,
    download: sticker ? () => downloadMedia({ message: { stickerMessage: sticker } }, { maxBytes: 2 * 1_048_576 }) : null,
  }).catch((error) => console.warn("[STIKER] Gagal mencatat stiker:", error.message));
}

// Penanda teks untuk gambar/video/stiker saat fitur "media" mati.
function visualPlaceholder(m) {
  const content = unwrapMediaWrappers(m.message) || {};
  if (content.stickerMessage) return "[mengirim stiker]";
  if (content.videoMessage) return "[mengirim video]";
  if (content.imageMessage) return "[mengirim gambar]";
  return "";
}

// Teks riwayat untuk stiker manusia; stiker yang ada di koleksi Grad diberi maknanya.
async function stickerHistoryText(m) {
  const sticker = unwrapMediaWrappers(m.message)?.stickerMessage;
  const sha = sticker ? stickerSha(sticker.fileSha256) : null;
  if (!sha) return "[mengirim stiker]";
  try {
    const label = await getStickerLibrary().labelFor(sha);
    return label ? `[mengirim stiker: ${label}]` : "[mengirim stiker]";
  } catch {
    return "[mengirim stiker]";
  }
}

async function runLegacyMessageFlow({
  m,
  jid,
  isGroup,
  isAllowedGroup,
  text,
  cmd,
  senderJid,
  senderTag,
  senderIdentities,
  senderPhoneVerified,
  fromOwner,
  loadSenderMetadata,
  earlyMedia,
  metadataCache,
  senderParticipant,
  activeSock,
}) {
  const currentSock = activeSock || sock;

  observeStickerTraffic({ m, jid, isGroup, isAllowedGroup, text, senderJid, senderTag, senderPhoneVerified });

  // /task hanyalah alias: isinya diperlakukan sebagai pesan yang ditujukan ke
  // bot dan masuk agent loop seperti mention biasa (Plan v2 M1).
  let forceAddressed = false;
  const taskAlias = text.match(/^[/!]task(?:\s+([\s\S]*))?$/i);
  if (taskAlias) {
    const permitted = (!isGroup && (fromOwner || memoryStore.canDirectMessage(senderJid))) || (isGroup && isAllowedGroup);
    if (!permitted) return;
    if (!taskAlias[1]?.trim()) {
      await currentSock.sendMessage(jid, { text: "Tulis permintaannya setelah /task, atau langsung mention aku aja." });
      return;
    }
    text = taskAlias[1].trim();
    cmd = text.toLowerCase();
    forceAddressed = true;
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
      await scheduler.clearJobs();
    } else if (arg === "social") {
      // /agent social on|off: jalur nimbrung sosial grup ini (jalur bantuan tetap jalan).
      const value = cmd.split(/\s+/)[2];
      if (!isGroup || !["on", "off"].includes(value)) {
        await sock.sendMessage(jid, { text: "Pakai di dalam grup: /agent social on atau /agent social off" });
        return;
      }
      featureSettings.setGroupFeature(jid, "sosial", value === "on", { phone: senderJid, role: "owner" });
      if (value === "on") proactiveState.unmute(jid);
    }
    const state = await scheduler.status();
    const social = isGroup ? proactiveState.status(jid) : null;
    const usage = agentUsage.today();
    const budget = agentUsage.budgetConfig();
    await sock.sendMessage(jid, {
      text: [
        "🤖 *STATUS AGEN GRAD*",
        `Aktif: ${state.enabled ? "ya" : "tidak"}`,
        `Tugas hari ini: ${usage.tasks} (${usage.steps} langkah, ${usage.searches} pencarian web, ${usage.fetches} baca link, ${usage.audio} audio)`,
        `Token: ${usage.tokens} · biaya $${usage.cost.toFixed(3)} dari budget harian $${budget.dailyUsd}${usage.cost >= budget.dailyUsd ? " (habis: tools dimatikan sampai besok)" : ""}`,
        `DM proaktif: ${state.proactive ? "boleh" : "tidak"}`,
        `Job menunggu: ${state.jobs}`,
        `DM proaktif hari ini: ${state.proactiveToday}/${state.dailyLimit}`,
        `Jam tenang: ${state.quiet ? "ya (bot tidak memulai DM atau nimbrung sosial)" : "tidak"}`,
        ...(social ? [
          `Nimbrung sosial di grup ini: ${featureSettings.isEnabled(jid, "sosial") ? "aktif" : "mati"}${social.mutedUntil ? ` · diminta diam sampai ${new Date(social.mutedUntil).toLocaleTimeString("id-ID", { timeZone: "Asia/Jayapura", hour: "2-digit", minute: "2-digit" })} WIT` : ""} · ${social.socialLastHour} kali dalam 1 jam`,
          `Masuk untuk bantuan: ${social.help.ok ? "siap" : social.help.reason}`,
        ] : []),
        "",
        "Perintah: /agent on, /agent off, /agent clear, /agent status, /agent social on|off",
      ].join("\n"),
    });
    return;
  }

  // ===== KOLEKSI STIKER GRAD (khusus owner) =====
  if (await handleStickerCommand({ sock, jid, cmd, text, fromOwner })) return;

  // ===== FITUR PER GRUP (admin WA grup lewat DM; di grup read-only) =====
  if (await handleFeatureCommand({
    sock,
    jid,
    isGroup,
    isAllowedGroup,
    cmd,
    fromOwner,
    senderPhone: senderJid,
    listGroups: () => adminGroupsFor(senderIdentities, currentSock),
    canReply: memoryStore.canDirectMessage(senderJid),
  })) return;

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

  // ===== VOICE NOTE: "telinga" Grad =====
  // Voice note (langsung atau yang di-reply) ditranskrip Gemini sebelum Jev,
  // hanya di grup yang diizinkan dan DM yang di-whitelist.
  const voicePermitted = isGroup ? isAllowedGroup : (fromOwner || memoryStore.canDirectMessage(senderJid));
  const voice = voicePermitted ? await readVoiceNotes(m, { jid, isGroup, senderJid }) : null;
  if (voice?.direct && !text) text = voice.direct.text;
  const quotedText = getQuotedText(m) || voice?.quoted?.text || "";
  const audio = voice?.direct?.audio || voice?.quoted?.audio || null;

// ===== CHAT PRIBADI (DM) =====
  if (!isGroup) {
    // Perintah tidak dikenal di DM diabaikan; media tanpa caption tetap diproses.
    if (text.startsWith("/")) return;
    // Fitur "media" mati: gambar/video tidak diunduh untuk AI, cukup penanda teks.
    const dmMediaOn = featureSettings.isEnabled(`${memoryStore.normalizePhone(senderJid)}@s.whatsapp.net`, "media");
    const dmMedia = dmMediaOn ? earlyMedia || (await getAiMedia(m)) : null;
    const dmVisual = !dmMediaOn && visualPlaceholder(m);
    if (!text && !dmMedia && !dmVisual) return;
    await directAgent.processDirectMessage({
      sock,
      message: m,
      phone: senderJid,
      senderName: m.pushName || senderTag,
      text: text || dmVisual || (dmMedia?.kind === "sticker" ? await stickerHistoryText(m) : dmMedia?.type === "video" ? "[mengirim video]" : "[mengirim gambar]"),
      quotedText,
      media: dmMedia,
      audio,
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
  const mediaOn = featureSettings.isEnabled(jid, "media");
  const aiMedia = mediaOn ? earlyMedia || (await getAiMedia(m)) : null;
  const visual = !mediaOn && visualPlaceholder(m);
  if (!text && !aiMedia && !visual) return;
  const contextInfo = getContextInfo(m);
  const mentioned = (contextInfo.mentionedJid || []).map(normalizeJid);
  const metadataMention = Boolean(botIdentities().some((id) => mentioned.includes(id)));
  const nameMention = groupAgent.textMentionsBotName(text);
  const explicitMention = metadataMention || nameMention || forceAddressed;
  const replyToBot = isReplyToBot(contextInfo);
  const decoratedText = decorateMentions(text, contextInfo, metadataCache);
  const decoratedQuoted = decorateMentions(quotedText, contextInfo, metadataCache);

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
    text: decoratedText || visual || (aiMedia?.kind === "sticker" ? await stickerHistoryText(m) : aiMedia?.type === "video" ? "[mengirim video]" : "[mengirim gambar]"),
    explicitMention,
    replyToBot,
    media: aiMedia,
    audio,
    quotedText: decoratedQuoted,
  });
}

async function dispatchInboundMessage(m, {
  sock: customSock = null,
  lifecycle: customLifecycle = null,
} = {}) {
  const activeSock = customSock || sock;
  if (!m?.message || m?.key?.fromMe) return null;

  const currentLifecycle = customLifecycle !== undefined ? customLifecycle : getGlobalLifecycle();
  const isLegacy = !currentLifecycle || currentLifecycle.isLegacy();

  const jid = m.key.remoteJid;
  const isGroup = jid.endsWith("@g.us");
  const text = getText(m);
  const isAllowedGroup = isGroup && data.allowedGroups.includes(jid);
  let earlyMedia = null;
  if (!text) {
    if (isGroup && !isAllowedGroup) return null;
    earlyMedia = await getAiMedia(m);
    // Stiker tetap dicatat koleksi walau unduhan untuk AI gagal; voice note
    // diproses "telinga" Grad di runLegacyMessageFlow.
    const content = unwrapMediaWrappers(m.message) || {};
    if (!earlyMedia && !content.stickerMessage && !content.audioMessage) return null;
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
    if (metadataCache === undefined) metadataCache = await getGroupMetadataSafe(jid, activeSock);
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

  if (isGroup && (cmd.startsWith("/") || isAllowedGroup || !isLegacy)) {
    await loadSenderMetadata();
    senderTag = phoneIdentity(senderJid);
  }

  // ==========================================
  // JIKA MODE LEGACY: 100% JALUR ASLI BOT (NOL DB TASK / INBOX EVENT)
  // ==========================================
  if (isLegacy) {
    return runLegacyMessageFlow({
      m,
      jid,
      isGroup,
      isAllowedGroup,
      text,
      cmd,
      senderJid,
      senderTag,
      senderIdentities,
      senderPhoneVerified,
      fromOwner,
      loadSenderMetadata,
      earlyMedia,
      metadataCache,
      senderParticipant,
      activeSock,
    });
  }

  // ==========================================
  // MODE SHADOW & AGENT (AUTONOMOUS TASK RUNTIME)
  // ==========================================
  // 1. ProcessLock guard: jika lock tidak dipegang, fail closed (no-op, nol DB write)
  if (!currentLifecycle.lockHeld) {
    return { status: "lock_not_held", handled: false };
  }

  const inboxManager = currentLifecycle.getInboxManager();
  if (!inboxManager) {
    return { status: "inbox_unavailable", handled: false };
  }

  // 2. Hubungkan /clear dan /reset ke context epoch bump
  if (cmd === "/clear" || cmd === "/reset") {
    const vetoCandidates = [...senderIdentities, senderJid];
    const hasVeto = groupVetoUsers(jid).some((allowed) => vetoCandidates.some((identity) => identitiesMatch(allowed, identity)));
    const metadata = fromOwner || hasVeto ? metadataCache : await loadSenderMetadata();
    const fromGroupAdmin = metadata
      ? Boolean(senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin" || isAdminParticipant(metadata, senderJid))
      : false;

    if (!fromOwner && !hasVeto && !fromGroupAdmin) {
      if (!currentLifecycle.isShadow() && activeSock) {
        await activeSock.sendMessage(jid, { text: "Hanya owner, admin grup, atau anggota dengan akses veto yang bisa mengelola memori Grad." });
      }
      return { status: "unauthorized_epoch_bump", handled: true };
    }

    const newEpoch = await currentLifecycle.bumpChatEpoch(jid, { reason: cmd.slice(1) });
    if (currentLifecycle.isShadow()) {
      return { status: "shadow_epoch_bumped", epoch: newEpoch, handled: true };
    }

    if (cmd === "/clear") {
      groupAgent.clearConversation(jid);
      if (activeSock) {
        await activeSock.sendMessage(jid, { text: "Percakapan aktif sudah dibersihkan. Memori compact tetap disimpan." });
      }
    } else {
      groupAgent.resetGroupContext(jid);
      if (activeSock) {
        await activeSock.sendMessage(jid, { text: "Konteks percakapan dan seluruh memori Grad untuk grup ini sudah direset." });
      }
    }
    return { status: "epoch_bumped", epoch: newEpoch, handled: true };
  }

  // 3. Evaluasi apakah pesan dialamatkan ke bot
  const contextInfo = getContextInfo(m);
  const mentioned = (contextInfo.mentionedJid || []).map(normalizeJid);
  const metadataMention = Boolean(botIdentities().some((id) => mentioned.includes(id)));
  const nameMention = groupAgent.textMentionsBotName(text);
  const explicitMention = metadataMention || nameMention;
  const replyToBot = isReplyToBot(contextInfo);
  const isDirectTaskCommand = /^[!/]task\b/i.test(text);

  const addressedToBot = !isGroup || explicitMention || replyToBot || isDirectTaskCommand;

  // Jika pesan di grup dan TIDAK dialamatkan ke bot: jangan buat task!
  if (isGroup && !addressedToBot) {
    return { status: "ignored_non_addressed_group", handled: false };
  }

  // 4. Raw LID fail-closed guard
  const isRawLid = senderJid.includes("@lid") || senderJid.endsWith(".lid") || (!senderPhoneVerified && String(m.key?.participant || "").includes("@lid"));
  if (isRawLid) {
    console.warn(`[RUNTIME] Raw WhatsApp LID ditolak fail-closed (${senderJid})`);
    return { status: "rejected_raw_lid", handled: false };
  }

  if (isGroup && !isAllowedGroup) {
    return { status: "rejected_group_not_allowed", handled: false };
  }
  if (!isGroup && !memoryStore.canDirectMessage(senderJid)) {
    return { status: "rejected_dm_not_whitelisted", handled: false };
  }

  // 5. Tidak ada lagi router regex: semua pesan masuk jalur yang sama, dan Jev +
  //    agent loop yang memutuskan apakah itu tugas (Plan v2 M1).
  if (currentLifecycle.isShadow()) {
    return { status: "shadow_casual_message_ignored", handled: true };
  }
  return runLegacyMessageFlow({
    m,
    jid,
    isGroup,
    isAllowedGroup,
    text,
    cmd,
    senderJid,
    senderTag,
    senderIdentities,
    senderPhoneVerified,
    fromOwner,
    loadSenderMetadata,
    earlyMedia,
    metadataCache,
    senderParticipant,
    activeSock,
  });
}

async function handleMessage(m, options = {}) {
  return dispatchInboundMessage(m, options);
}

module.exports = {
  handleMessage,
  dispatchInboundMessage,
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
  initRuntime,
  shutdownRuntime,
  getGlobalLifecycle,
  initGlobalLifecycle,
};

if (require.main === module) {
  console.log("[*] Memulai WA Ping-Pong Bot (Baileys)...");
  console.log(groupAgent.isConfigured()
    ? `[AI] Aktif: ${groupAgent.config().jevModel} -> ${groupAgent.config().chatModel}`
    : "[AI] Nonaktif: ganti OPENROUTER_API_KEY di file .env");
  initReadline();
  process.on("SIGINT", async () => {
    await shutdownRuntime();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdownRuntime();
    process.exit(0);
  });
  startBot();
  // Dashboard owner lokal (127.0.0.1:7777). Gagal start tidak menghentikan bot.
  require("./ai/dashboard/server").startDashboard({
    startedAt,
    isConnected: () => connectionOpen,
    botUser: () => sock?.user?.id || null,
    getData: () => data,
    groupSubject: async (groupId) => (await getGroupMetadataSafe(groupId))?.subject || null,
  });
}
