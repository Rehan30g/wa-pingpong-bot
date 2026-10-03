// Tag orang sungguhan di grup (27 Sep): GLM menulis "@Nama", kode mencocokkan
// nama ke anggota grup yang dikenal (riwayat + memori orang) lalu mengirim
// mention WhatsApp (teks "@<id>" + `mentions`). Tidak pernah @semua/massal.
const memoryStore = require("../memory-store");
const membersDirectory = require("./members");

const MAX_MENTIONS = 3;
const MASS_TAGS = new Set(["all", "semua", "semuanya", "everyone", "here", "grup", "group", "member", "members", "kalian"]);
const MENTION_PATTERN = /(^|[\s(])@([\p{L}][\p{L}\p{N}_.'-]{0,30})/gu;

// Resolver JID (dipasang index.js): nomor → JID anggota grup (bisa LID), atau null.
let jidResolver = null;
function setMentionJidResolver(fn) {
  jidResolver = typeof fn === "function" ? fn : null;
}

const fold = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

/** Anggota yang dikenal di grup: [{ phone, names: [...] }]. */
function knownMembers(groupId, history = []) {
  const byPhone = new Map();
  const add = (phone, name) => {
    const key = memoryStore.normalizePhone(phone);
    if (!/^\d{8,15}$/.test(key) || !name) return;
    if (!byPhone.has(key)) byPhone.set(key, new Set());
    byPhone.get(key).add(String(name));
  };
  for (const item of history) if (!item.is_bot) add(item.sender_id, item.sender);
  for (const person of memoryStore.listPeople()) {
    if (!person.groups?.includes(groupId)) continue;
    for (const name of [person.name, ...(person.aliases || []), ...(person.nicknames || [])]) add(person.phone, name);
  }
  // Anggota dari metadata grup (juga yang belum pernah chat) + nama panggilan.
  for (const member of membersDirectory.cachedMembers(groupId)) {
    if (!member.phone) continue;
    for (const name of [...member.names, ...member.nicknames]) add(member.phone, name);
  }
  return [...byPhone.entries()].map(([phone, names]) => ({ phone, names: [...names] }));
}

// Nama utuh atau nama depan yang unik; ambigu (dua orang bernama sama) = tidak ditag.
function matchMember(members, token) {
  const wanted = fold(token);
  if (!wanted) return null;
  const exact = members.filter((member) => member.names.some((name) => fold(name) === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const first = members.filter((member) => member.names.some((name) => fold(String(name).split(/\s+/)[0]) === wanted));
  if (first.length) return first.length === 1 ? first[0] : null;
  // Kata lain dari nama ("@Juan" untuk "Kak Juan"), asal hanya satu orang.
  const word = members.filter((member) => member.names.some((name) => String(name).split(/\s+/).some((part) => fold(part) === wanted)));
  return word.length === 1 ? word[0] : null;
}

/**
 * Ubah "@Nama" di teks jadi mention sungguhan. Mengembalikan { text, mentions }.
 * allow=false (mis. nimbrung) → semua "@" dibuang menjadi nama biasa.
 */
// Uji 3 Okt: "@Bima -Sakti" hanya membaca "X", sisa "-Sakti" tertinggal sebagai teks.
// Coba gabungan 4..2 kata setelah "@" yang sama persis dengan nama lengkap anggota.
function longestNameMatch(members, value, start) {
  const words = [];
  const pattern = /\S+/gy;
  let index = start;
  while (words.length < 4) {
    const gap = value.slice(index).match(/^[ \t]+/);
    if (words.length && !gap) break;
    if (gap) index += gap[0].length;
    pattern.lastIndex = index;
    const word = pattern.exec(value);
    if (!word) break;
    words.push({ end: index + word[0].length });
    index += word[0].length;
  }
  for (let count = words.length; count >= 2; count--) {
    const raw = value.slice(start, words[count - 1].end);
    const candidate = raw.replace(/[.,!?;:)]+$/u, "");
    const found = members.filter((member) => member.names.some((name) => /\s/.test(name.trim()) && fold(name) === fold(candidate)));
    if (found.length === 1) return { member: found[0], length: candidate.length };
  }
  return null;
}

async function applyMentions(groupId, text, { history = [], allow = true, max = MAX_MENTIONS } = {}) {
  const value = String(text || "");
  if (!value.includes("@")) return { text: value, mentions: [] };
  const members = allow ? knownMembers(groupId, history) : [];
  const mentions = [];
  const replacements = [];
  for (const match of value.matchAll(MENTION_PATTERN)) {
    let [whole, lead, token] = match;
    let replacement = `${lead}${token}`;
    if (allow && !MASS_TAGS.has(fold(token)) && mentions.length < max) {
      const tokenStart = match.index + lead.length + 1;
      const full = longestNameMatch(members, value, tokenStart);
      if (full) {
        whole = `${lead}@${value.slice(tokenStart, tokenStart + full.length)}`;
        replacement = whole.slice(0, lead.length) + whole.slice(lead.length + 1);
      }
      const member = full?.member || matchMember(members, token);
      let jid = member ? `${member.phone}@s.whatsapp.net` : null;
      if (member && jidResolver) {
        try {
          jid = (await jidResolver(groupId, member.phone)) || null;
        } catch {
          jid = null;
        }
      }
      if (jid) {
        if (!mentions.includes(jid)) mentions.push(jid);
        replacement = `${lead}@${jid.split("@")[0].split(":")[0]}`;
      }
    }
    replacements.push({ index: match.index, length: whole.length, replacement });
  }
  let result = value;
  for (const item of replacements.reverse()) result = result.slice(0, item.index) + item.replacement + result.slice(item.index + item.length);
  return { text: result, mentions };
}

module.exports = { MAX_MENTIONS, applyMentions, knownMembers, matchMember, setMentionJidResolver };
