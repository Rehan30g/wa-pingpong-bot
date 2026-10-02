// Titip pesan dari DM ke grup (keputusan owner 27 Sep): selalu terang-terangan atas
// nama pengirim ("Rehan titip pesan: …"), hanya ke grup aktif yang dia ikuti, tanpa
// tag massal, maks N per orang per hari. Pesan yang menyangkut orang lain (tag,
// nagih, tegur) wajib draf + konfirmasi; yang dikirim adalah draf tersimpan, bukan
// teks baru dari model (anti ganti isi diam-diam).
const crypto = require("node:crypto");
const { witParts } = require("../humanize");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const relayConfig = () => ({
  dailyLimit: Math.max(0, envNumber("AGENT_RELAY_DAILY_LIMIT", 5)),
  draftTtlMs: 30 * 60_000,
  maxChars: 800,
});

// Tanpa \b di depan supaya imbuhan ikut tertangkap (dibayar, ditagih, bayarin, pelunasan).
const SENSITIVE = /(bayar|utang|hutang|nagih|tagih|transfer|lunas|tegur|negur|marah|kesel|kecewa|nunggak)/i;
const MASS_TAG = /@(all|semua|semuanya|everyone|here)\b/i;

const drafts = new Map(); // phone -> { id, groupId, subject, text, at }
const usage = new Map(); // phone -> { day, count }

function dayKey(at = Date.now()) {
  const p = witParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

function usedToday(phone, at = Date.now()) {
  const entry = usage.get(phone);
  return entry && entry.day === dayKey(at) ? entry.count : 0;
}

function pickGroup(groups, wanted) {
  if (!groups.length) return { error: "dia belum tercatat di grup mana pun tempat kamu aktif" };
  const query = String(wanted || "").trim().toLowerCase();
  if (!query) return groups.length === 1 ? { group: groups[0] } : { error: `sebutkan grupnya: ${groups.map((g) => g.subject).join(", ")}` };
  const exact = groups.filter((g) => g.subject.toLowerCase() === query);
  const partial = exact.length ? exact : groups.filter((g) => g.subject.toLowerCase().includes(query));
  if (partial.length === 1) return { group: partial[0] };
  return { error: partial.length ? `nama grup ambigu: ${partial.map((g) => g.subject).join(", ")}` : `grup '${wanted}' bukan grup yang dia ikuti; pilihannya: ${groups.map((g) => g.subject).join(", ")}` };
}

/**
 * relay = { phone, name, groups: [{ id, subject }], queue: [] } (dari DM).
 * Mengembalikan hasil untuk model; pesan yang lolos masuk relay.queue.
 */
function request(relay, { group, text, confirm = false, confirm_draft: confirmDraft } = {}, at = Date.now()) {
  const cfg = relayConfig();
  if (usedToday(relay.phone, at) + relay.queue.length >= cfg.dailyLimit) return { error: `kuota titipan hari ini (${cfg.dailyLimit}) sudah habis` };

  // Konfirmasi datang di giliran berikutnya ("oke kirim"), saat draft_id sudah tidak
  // terlihat model: cukup confirm=true untuk draf yang sedang menunggu milik orang ini.
  if (confirm || confirmDraft) {
    const draft = drafts.get(relay.phone);
    if (!draft || (confirmDraft && draft.id !== confirmDraft) || at - draft.at > cfg.draftTtlMs) return { error: "tidak ada draf yang menunggu (atau sudah kedaluwarsa); buat draf baru" };
    // Persetujuan harus datang dari pesan dia berikutnya, bukan diputuskan model di giliran yang sama.
    if (draft.turn === relay) return { error: "draf ini baru dibuat; tunjukkan preview-nya dan tunggu dia setuju di pesan berikutnya", preview: `${relay.name} titip pesan: ${draft.text}` };
    drafts.delete(relay.phone);
    relay.queue.push({ groupId: draft.groupId, subject: draft.subject, text: draft.text });
    return { ok: true, sent_to: draft.subject, text: draft.text, note: "terkirim ke grup setelah balasanmu, atas nama dia" };
  }

  // Awalan "<nama> titip pesan:" ditambahkan kode saat mengirim; buang kalau model ikut menulisnya.
  const body = String(text || "").replace(/\s+\n/g, "\n").trim()
    .replace(new RegExp(`^(?:${String(relay.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+)?titip(?:an)?\\s+pesan\\s*:\\s*`, "i"), "")
    .slice(0, cfg.maxChars);
  if (!body) return { error: "isi pesannya kosong" };
  if (MASS_TAG.test(body)) return { error: "tidak boleh tag semua anggota" };
  const picked = pickGroup(relay.groups, group);
  if (picked.error) return { error: picked.error };

  // Menyangkut orang lain (tag / nagih / tegur) → tunjukkan draf dulu.
  if (body.includes("@") || SENSITIVE.test(body)) {
    const id = crypto.randomBytes(3).toString("hex");
    drafts.set(relay.phone, { id, groupId: picked.group.id, subject: picked.group.subject, text: body, at, turn: relay });
    return {
      needs_confirmation: true,
      draft_id: id,
      preview: `${relay.name} titip pesan: ${body}`,
      group: picked.group.subject,
      note: "tunjukkan preview ini ke dia dan tanya singkat boleh dikirim; kalau dia setuju (di pesan berikutnya), panggil tell_group dengan confirm: true saja",
    };
  }
  relay.queue.push({ groupId: picked.group.id, subject: picked.group.subject, text: body });
  return { ok: true, sent_to: picked.group.subject, text: body, note: "terkirim ke grup setelah balasanmu, atas nama dia" };
}

// Dipanggil setelah benar-benar terkirim.
function markSent(phone, at = Date.now()) {
  const day = dayKey(at);
  const entry = usage.get(phone);
  usage.set(phone, { day, count: (entry?.day === day ? entry.count : 0) + 1 });
}

function reset() {
  drafts.clear();
  usage.clear();
}

module.exports = { markSent, relayConfig, request, reset, usedToday };
