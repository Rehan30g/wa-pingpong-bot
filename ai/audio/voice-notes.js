// Transkripsi otomatis voice note saat pesan masuk (Plan v2 §4b jalur 1).
// Wajib karena Jev hanya membaca teks. Hasilnya masuk riwayat sebagai
// `[voice note 0:42] "…"`, dan mp3-nya disimpan di memori untuk listen_audio.
const ears = require("./ears");
const usageTracker = require("../agent/usage");

const CACHE_LIMIT = 30;
const cache = new Map(); // id pesan WA -> { text, audio }

function remember(id, value) {
  if (!id) return;
  cache.delete(id);
  cache.set(id, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/**
 * @param {object} args
 * @param {object} args.audioMessage audioMessage Baileys
 * @param {string} [args.messageId] id pesan WA (cache; voice note yang di-reply tidak didengar ulang)
 * @param {Function} args.download async () => Buffer
 * @param {object} [args.context] { botName, participants, recent }
 */
async function processVoiceNote({ audioMessage, messageId, download, context = {}, deps = {} }) {
  if (!audioMessage) return null;
  if (messageId && cache.has(messageId)) return cache.get(messageId);
  const cfg = ears.audioConfig();
  const seconds = Number(audioMessage.seconds) || 0;
  const ptt = audioMessage.ptt !== false;
  const declared = Number(audioMessage.fileLength?.low ?? audioMessage.fileLength) || 0;
  if (declared > cfg.maxBytes) {
    return { text: `[${ptt ? "voice note" : "audio"} ${ears.formatDuration(seconds)}, terlalu besar untuk didengar]`, audio: null };
  }

  let mp3 = null;
  let transcript = null;
  try {
    const raw = await download();
    if (!raw?.length) throw new Error("audio_download_empty");
    mp3 = await (deps.toMp3 || ears.toMp3)(raw, { maxSec: cfg.maxSec });
    transcript = await (deps.transcribe || ears.transcribe)({ mp3, ...context });
    usageTracker.recordAudio({ cost: transcript.cost || 0 });
  } catch (error) {
    console.warn("[AUDIO] Voice note gagal diproses:", String(error.message || error).slice(0, 160));
  }
  const result = {
    text: ears.voiceNoteText(transcript, { seconds, ptt, truncated: seconds > cfg.maxSec }),
    audio: mp3 ? { mp3, seconds } : null,
    transcript,
  };
  remember(messageId, result);
  return result;
}

function clearVoiceCache() {
  cache.clear();
}

module.exports = { clearVoiceCache, processVoiceNote };
