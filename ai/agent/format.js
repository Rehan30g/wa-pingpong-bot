// Jawaban akhir agent loop berupa teks bebas: GLM mengabaikan response_format
// saat tools aktif (probe M1). Kutipan dipilih lewat penanda [[reply:#id]].

const REPLY_MARKER = /\[\[\s*reply\s*:\s*#?(\d+)\s*\]\]/i;

// Ubah Markdown yang sering keluar dari model menjadi format WhatsApp.
function toWhatsApp(value) {
  let text = String(value || "").replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "");
  // [judul](url) -> judul (url); link yang teksnya sama dengan URL cukup URL-nya.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => (label.trim() === url ? url : `${label.trim()} (${url})`));
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "*$1*").replace(/__([^_\n]+)__/g, "_$1_");
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, "*$1*");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  // Tabel Markdown: buang baris pemisah, ubah sel jadi " · ".
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?:\n|$)/gm, "");
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, cells) => cells.split("|").map((c) => c.trim()).filter(Boolean).join(" · "));
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function truncate(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${(lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trimEnd()}…`;
}

/**
 * Ambil teks + target kutipan dari jawaban akhir. Menerima juga bentuk JSON
 * lama {text, reply_to_entry_id} karena GLM kadang tetap menulisnya.
 */
function parseFinalReply(content, { maxChars } = {}) {
  let raw = String(content || "").trim();
  let replyToEntryId = null;
  const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (fenced.startsWith("{")) {
    try {
      const parsed = JSON.parse(fenced);
      if (typeof parsed?.text === "string") {
        raw = parsed.text;
        if (Number.isInteger(parsed.reply_to_entry_id)) replyToEntryId = parsed.reply_to_entry_id;
      }
    } catch {}
  }
  const marker = raw.match(REPLY_MARKER);
  if (marker) {
    replyToEntryId = Number(marker[1]);
    raw = raw.replace(REPLY_MARKER, "");
  }
  return { text: truncate(toWhatsApp(raw), maxChars), replyToEntryId };
}

module.exports = { parseFinalReply, toWhatsApp, truncate, REPLY_MARKER };
