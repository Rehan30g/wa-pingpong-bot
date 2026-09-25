/**
 * Task Intent Router Bounded & Deterministik untuk Fase 3
 *
 * Persyaratan:
 * 1. Menentukan apakah pesan masuk adalah intent task yang valid dan terotorisasi SEBELUM planner.
 * 2. Allowlist intent Fase 3 ketat:
 *    - 'create_note': Menyimpan catatan baru untuk chat aktif.
 *    - 'read_note': Membaca catatan yang ada pada chat aktif.
 *    - 'summarize_context': Meringkas percakapan atau teks tertentu.
 * 3. User direction eksplisit:
 *    - Perintah khusus: /task, /catat, /note, /baca, /readnote, /ringkas, /summarize, /rangkum.
 *    - Arahan natural language yang jelas ditujukan ke bot (mis. "buatkan catatan: ...", "ringkaskan rapat ini").
 * 4. Pesan biasa / obrolan manusia / ping-pong / salam TIDAK BOLEH masuk ke task runner.
 * 5. TIDAK menggunakan GLM untuk menentukan identitas, authorization, atau policy.
 */

const { safePublicQuery } = require("../capabilities/web-search");
const { isSafeFact } = require("../capabilities/memory-facts");
const ALLOWED_INTENTS = Object.freeze(["create_note", "read_note", "summarize_context", "memory_remember", "memory_search", "memory_correct", "web_search", "web_fetch", "fetch_media_from_url", "fetch_media_from_message", "make_sticker", "send_asset"]);

/**
 * Membersihkan teks dari mention bot (@628xxx atau @NamaBot)
 */
function stripBotMentions(rawText = "") {
  let cleaned = String(rawText || "").trim();
  // Hilangkan tag @number atau @botname di awal kalimat
  cleaned = cleaned.replace(/^@(?:[0-9a-zA-Z._-]+)\s*/i, "").trim();
  return cleaned;
}

/**
 * Mengevaluasi pesan dan mengembalikan taskIntent jika cocok dengan allowlist Fase 3,
 * atau null bila merupakan pesan biasa/non-task.
 *
 * @param {string} rawText Teks pesan masuk
 * @param {object} context Objek konteks (isGroup, fromOwner, addressedToBot)
 * @returns {object|null}
 */
function routeTaskIntent(rawText, { isGroup = false, fromOwner = false, addressedToBot = true } = {}) {
  if (!rawText || typeof rawText !== "string") {
    return null;
  }

  // Jika pesan di dalam grup dan TIDAK ditujukan ke bot, abaikan
  if (isGroup && !addressedToBot) {
    return null;
  }

  const text = stripBotMentions(rawText);
  if (!text) return null;

  // 1. Eksekusi perintah /task eksplisit
  if (text.startsWith("/task") || text.startsWith("!task")) {
    const sub = text.replace(/^[/!]task\s*/i, "").trim();
    if (!sub) return null;

    if (/^kirim\s+stiker\b/i.test(sub) && process.env.AGENT_MESSAGE_MEDIA_ENABLED === "true" && process.env.AGENT_MAKE_STICKER_ENABLED === "true" && process.env.AGENT_SEND_ASSET_ENABLED === "true") {
      return { intent: "send_asset", goal: "Ambil gambar dari pesan sumber ini, buat stiker WebP, lalu kirim stiker itu ke chat asal.", acceptanceCriteria: "Stiker terkirim dengan receipt transport terverifikasi", risk_level: "medium", scope: "active_chat,write,send" };
    }

    if (/^(stiker|sticker|make_sticker)\b/i.test(sub) && process.env.AGENT_MESSAGE_MEDIA_ENABLED === "true" && process.env.AGENT_MAKE_STICKER_ENABLED === "true") {
      return { intent: "make_sticker", goal: "Ambil gambar dari pesan sumber ini dan buat asset stiker WebP 512x512.", acceptanceCriteria: "Asset stiker WebP dibuat dan terverifikasi", risk_level: "medium", scope: "active_chat,write" };
    }

    if (/^(media|lihat\s+media|fetch_media_from_message)\b/i.test(sub) && process.env.AGENT_MESSAGE_MEDIA_ENABLED === "true") {
      return { intent: "fetch_media_from_message", goal: "Ambil asset gambar dari pesan sumber ini.", acceptanceCriteria: "Asset gambar dari pesan sumber terverifikasi", risk_level: "low", scope: "active_chat" };
    }

    if (/^(ingat|memory_remember)\b/i.test(sub) && process.env.AGENT_MEMORY_FACTS_ENABLED === "true") {
      const detail = sub.replace(/^(ingat|memory_remember)\b[:\s]*/i, "").trim();
      if (!isSafeFact(detail)) return null;
      return { intent: "memory_remember", goal: `Ingat fakta: ${detail}`, acceptanceCriteria: "Fakta bersumber tersimpan dan terbaca kembali", risk_level: "low", scope: "active_chat,write" };
    }

    if (/^(cari\s+memori|memory_search)\b/i.test(sub) && process.env.AGENT_MEMORY_FACTS_ENABLED === "true") {
      const query = sub.replace(/^(cari\s+memori|memory_search)\b[:\s]*/i, "").trim();
      if (!query || query.length > 120) return null;
      return { intent: "memory_search", goal: `Cari fakta dalam chat ini: ${query}`, acceptanceCriteria: "Hasil memori sesuai chat dan bersumber", risk_level: "low", scope: "active_chat" };
    }

    if (/^(koreksi\s+memori|memory_correct)\b/i.test(sub) && process.env.AGENT_MEMORY_FACTS_ENABLED === "true") {
      const detail = sub.replace(/^(koreksi\s+memori|memory_correct)\b[:\s]*/i, "").trim();
      const match = /^(mem_[a-f0-9]{32})\s*:\s*([\s\S]+)$/.exec(detail);
      if (!match || !isSafeFact(match[2])) return null;
      return { intent: "memory_correct", goal: `Koreksi fakta ${match[1]}: ${match[2].trim()}`, acceptanceCriteria: "Koreksi tersimpan dan versi lama tidak lagi dibaca", risk_level: "low", scope: "active_chat,write" };
    }

    if (/^(web|web_fetch|baca\s+web)\b/i.test(sub) && process.env.AGENT_WEB_FETCH_ENABLED === "true") {
      const url = sub.replace(/^(web|web_fetch|baca\s+web)\b[:\s]*/i, "").trim();
      if (!/^https:\/\/[^\s?#]+$/i.test(url)) return null;
      return { intent: "web_fetch", goal: `Baca teks dari URL ${url} dan laporkan sumbernya.`, acceptanceCriteria: "Teks dan URL sumber berhasil diverifikasi", risk_level: "medium", scope: "active_chat" };
    }

    if (/^(cari\s+web|web_search)\b/i.test(sub) && process.env.AGENT_WEB_SEARCH_ENABLED === "true") {
      const query = sub.replace(/^(cari\s+web|web_search)\b[:\s]*/i, "").trim();
      try { safePublicQuery(query); } catch { return null; }
      return { intent: "web_search", goal: `Cari informasi publik di web: ${query}`, acceptanceCriteria: "Jawaban dan URL sumber pencarian terverifikasi", risk_level: "medium", scope: "active_chat" };
    }

    if (/^(ambil\s+gambar|fetch_media_from_url)\b/i.test(sub) && process.env.AGENT_MEDIA_URL_ENABLED === "true") {
      const url = sub.replace(/^(ambil\s+gambar|fetch_media_from_url)\b[:\s]*/i, "").trim();
      if (!/^https:\/\/[^\s?#]+$/i.test(url)) return null;
      return { intent: "fetch_media_from_url", goal: `Unduh gambar dari URL ${url} sebagai asset di chat ini.`, acceptanceCriteria: "Asset gambar tersimpan dan terverifikasi", risk_level: "medium", scope: "active_chat" };
    }

    // Sub-intent create_note
    if (/^(catat|note|create_note|simpan(?:\s+catatan)?)\b/i.test(sub)) {
      const details = sub.replace(/^(catat|note|create_note|simpan(?:\s+catatan)?)\b[:\s]*/i, "").trim();
      return {
        intent: "create_note",
        goal: details ? `Buat catatan: ${details}` : "Buat catatan baru dari informasi penting",
        acceptanceCriteria: "Catatan berhasil disimpan dan memiliki note_id",
        risk_level: "low",
        scope: "active_chat,write",
        authorization_ref: fromOwner ? "owner_task" : "user_task_request",
      };
    }

    // Sub-intent read_note
    if (/^(baca|read|read_note|lihat(?:\s+catatan)?|buka(?:\s+catatan)?)\b/i.test(sub)) {
      const details = sub.replace(/^(baca|read|read_note|lihat(?:\s+catatan)?|buka(?:\s+catatan)?)\b[:\s]*/i, "").trim();
      return {
        intent: "read_note",
        goal: details ? `Baca catatan ${details}` : "Baca catatan aktif",
        acceptanceCriteria: "Isi catatan dapat dibaca kembali",
        risk_level: "low",
        scope: "active_chat",
      };
    }

    // Sub-intent summarize_context
    if (/^(ringkas|summarize|summarize_context|rangkum)\b/i.test(sub)) {
      const details = sub.replace(/^(ringkas|summarize|summarize_context|rangkum)\b[:\s]*/i, "").trim();
      return {
        intent: "summarize_context",
        goal: details ? `Ringkas: ${details}` : "Ringkas materi percakapan rapat aktif",
        acceptanceCriteria: "Ringkasan poin-poin penting berhasil dihasilkan",
        risk_level: "low",
        scope: "active_chat",
      };
    }

    // Perintah /task dengan kapabilitas di luar allowlist ditolak
    return null;
  }

  // 2. Perintah langsung /catat atau /note
  if (/^[/!](catat|note)\b/i.test(text)) {
    const details = text.replace(/^[/!](catat|note)\b[:\s]*/i, "").trim();
    return {
      intent: "create_note",
      goal: details ? `Buat catatan: ${details}` : "Buat catatan baru dari informasi penting",
      acceptanceCriteria: "Catatan berhasil disimpan dan memiliki note_id",
      risk_level: "low",
      scope: "active_chat,write",
      authorization_ref: fromOwner ? "owner_task" : "user_task_request",
    };
  }

  // 3. Perintah langsung /baca atau /readnote
  if (/^[/!](baca|readnote|bacanote)\b/i.test(text)) {
    const details = text.replace(/^[/!](baca|readnote|bacanote)\b[:\s]*/i, "").trim();
    return {
      intent: "read_note",
      goal: details ? `Baca catatan: ${details}` : "Baca catatan aktif",
      acceptanceCriteria: "Isi catatan dapat dibaca kembali",
      risk_level: "low",
      scope: "active_chat",
    };
  }

  // 4. Perintah langsung /ringkas atau /summarize atau /rangkum
  if (/^[/!](ringkas|summarize|rangkum)\b/i.test(text)) {
    const details = text.replace(/^[/!](ringkas|summarize|rangkum)\b[:\s]*/i, "").trim();
    return {
      intent: "summarize_context",
      goal: details ? `Ringkas: ${details}` : "Ringkas percakapan aktif",
      acceptanceCriteria: "Ringkasan poin-poin penting berhasil dihasilkan",
      risk_level: "low",
      scope: "active_chat",
    };
  }

  // 5. Arahan natural language eksplisit (ditujukan ke bot)
  // a. create_note: "tolong buatkan catatan ...", "catat ini: ..."
  const noteCreatePattern = /^(?:tolong\s+)?(?:buat(?:kan)?|simpan(?:kan)?|tulis(?:kan)?)\s+(?:catatan|note)\b(?::\s*|\s+)?(.*)$/i;
  const matchCreate = text.match(noteCreatePattern);
  if (matchCreate) {
    const content = matchCreate[1]?.trim() || "";
    return {
      intent: "create_note",
      goal: content ? `Buat catatan: ${content}` : "Buat catatan baru dari informasi penting",
      acceptanceCriteria: "Catatan berhasil disimpan dan memiliki note_id",
      risk_level: "low",
      scope: "active_chat",
    };
  }

  // b. read_note: "tolong bacakan catatan ...", "lihat catatan ..."
  const noteReadPattern = /^(?:tolong\s+)?(?:baca(?:kan)?|lihat|tampilkan|buka)\s+(?:catatan|note)\b(?::\s*|\s+)?(.*)$/i;
  const matchRead = text.match(noteReadPattern);
  if (matchRead) {
    const content = matchRead[1]?.trim() || "";
    return {
      intent: "read_note",
      goal: content ? `Baca catatan: ${content}` : "Baca catatan aktif",
      acceptanceCriteria: "Isi catatan dapat dibaca kembali",
      risk_level: "low",
      scope: "active_chat",
    };
  }

  // c. summarize_context: "ringkas rapat ini", "tolong buatkan ringkasan ..."
  const summarizePattern = /^(?:tolong\s+)?(?:ringkas(?:kan)?|buat(?:kan)?\s+ringkasan|rangkum(?:kan)?|buat(?:kan)?\s+rangkuman|summarize)\b(?::\s*|\s+)?(.*)$/i;
  const matchSumm = text.match(summarizePattern);
  if (matchSumm) {
    const content = matchSumm[1]?.trim() || "";
    return {
      intent: "summarize_context",
      goal: content ? `Ringkas: ${content}` : "Ringkas materi percakapan aktif",
      acceptanceCriteria: "Ringkasan poin-poin penting berhasil dihasilkan",
      risk_level: "low",
      scope: "active_chat",
    };
  }

  // 6. Pesan biasa / obrolan manusia / ping-pong / salam -> bukan task intent!
  return null;
}

module.exports = {
  ALLOWED_INTENTS,
  stripBotMentions,
  routeTaskIntent,
};
