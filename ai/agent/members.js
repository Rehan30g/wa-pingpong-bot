// Anggota grup untuk Grad (uji owner 3 Okt): "siapa aja org di grup ini?" dijawab
// "aku nggak bisa lihat daftar member", dan "tag si bim" gagal karena "Bim" cuma
// nama kontak di HP owner (di WhatsApp orangnya bernama "Bima -Sakti").
// Sumber: metadata grup WhatsApp (dipasang index.js) + nama yang diingat memory store
// + nama panggilan yang diajarkan member (`nicknames`, lewat tool remember_alias).
const memoryStore = require("../memory-store");

const CACHE_MS = 5 * 60_000;
const MAX_NICKNAMES = 5;
let provider = null; // async (groupId) => [{ phone, name, admin, lid }]
const cache = new Map(); // groupId -> { at, members }

function setGroupMembersProvider(fn) {
  provider = typeof fn === "function" ? fn : null;
  cache.clear();
}

const fold = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

function personNames(person) {
  return [person?.name, ...(person?.aliases || []), ...(person?.nicknames || [])].filter(Boolean);
}

/**
 * Anggota grup: [{ phone|null, names: [...], nicknames: [...], admin }].
 * Anggota yang hanya dikenal lewat LID (nomor HP tidak diketahui) tetap dihitung.
 */
async function groupMembers(groupId, { fresh = false } = {}) {
  const cached = cache.get(groupId);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.members;
  let raw = [];
  if (provider) {
    try {
      raw = (await provider(groupId)) || [];
    } catch (error) {
      console.warn("[ANGGOTA] Metadata grup gagal dibaca:", error.message);
    }
  }
  const byPhone = new Map();
  const unknown = [];
  for (const item of raw) {
    const phone = item.lid ? null : memoryStore.normalizePhone(item.phone);
    if (!phone || !/^\d{8,15}$/.test(phone)) {
      unknown.push({ phone: null, names: item.name ? [item.name] : [], nicknames: [], admin: Boolean(item.admin) });
      continue;
    }
    const person = memoryStore.getPerson(phone);
    const names = [...new Set([...personNames(person), item.name].filter(Boolean))];
    byPhone.set(phone, { phone, names, nicknames: [...(person?.nicknames || [])], admin: Boolean(item.admin) });
  }
  // Orang yang pernah chat di grup ini (nomor HP dari pesannya) selalu digabung: grup LID
  // tidak menyertakan nomor HP di metadata (3 Okt: Dimas tak dikenali → "dim" ditolak).
  let fromMemory = 0;
  for (const person of memoryStore.listPeople()) {
    if (!person.groups?.includes(groupId) || byPhone.has(person.phone)) continue;
    byPhone.set(person.phone, { phone: person.phone, names: personNames(person), nicknames: [...(person.nicknames || [])], admin: false });
    fromMemory++;
  }
  // Anggota LID tanpa nama kemungkinan besar orang-orang yang sama: jangan dihitung dua kali.
  const unnamed = unknown.filter((item) => !item.names.length);
  const named = unknown.filter((item) => item.names.length);
  unnamed.splice(0, Math.min(unnamed.length, raw.length ? fromMemory : 0));
  const members = [...byPhone.values(), ...named, ...unnamed];
  cache.set(groupId, { at: Date.now(), members });
  return members;
}

/** Versi sinkron dari cache (untuk pencocok tag yang tidak async). */
function cachedMembers(groupId) {
  return cache.get(groupId)?.members || [];
}

/** Baris konteks untuk prompt grup. */
function membersPromptLine(members = [], { isOwnerPhone = () => false } = {}) {
  if (!members.length) return "";
  const named = members.filter((member) => member.names.length);
  const label = (member) => {
    const extras = member.nicknames.length ? ` (dipanggil: ${member.nicknames.join(", ")})` : "";
    const role = member.phone && isOwnerPhone(member.phone) ? " (owner)" : member.admin ? " (admin)" : "";
    return `${member.names[0]}${extras}${role}`;
  };
  const shown = named.slice(0, 40).map(label);
  const rest = members.length - shown.length;
  return `Anggota grup ini menurut WhatsApp: ${members.length} orang. Yang kamu tahu namanya: ${shown.join("; ") || "-"}.${rest > 0 ? ` ${rest} lainnya belum pernah chat, namanya belum kamu ketahui.` : ""} Kalau diminta men-tag nama yang tidak ada di daftar, sebut 1–3 nama yang paling mirip TANPA tanda @ lalu tanya yang mana; kalau dijelaskan ('bim itu X'), simpan dengan remember_alias. Saat menyebut daftar anggota atau kandidat, tulis nama biasa tanpa @ (tanda @ = notifikasi ke orangnya); @ hanya untuk orang yang memang diminta dipanggil.`;
}

/**
 * Simpan nama panggilan untuk anggota grup. `member` = nama di WhatsApp/riwayat,
 * nama panggilan lama, atau nomor. Harus menunjuk tepat satu anggota.
 */
async function rememberAlias(groupId, { member, alias } = {}) {
  const nickname = String(alias || "").trim().replace(/^@/, "");
  if (!nickname || nickname.length > 30 || !/\p{L}/u.test(nickname)) return { error: "nama panggilan tidak valid (1–30 karakter, ada hurufnya)" };
  const members = (await groupMembers(groupId, { fresh: true })).filter((item) => item.phone);
  const wanted = fold(String(member || "").replace(/^@/, ""));
  const digits = String(member || "").replace(/\D/g, "");
  let matches = digits.length >= 8 ? members.filter((item) => item.phone.endsWith(digits.slice(-10))) : [];
  if (!matches.length && wanted) matches = members.filter((item) => [...item.names, ...item.nicknames].some((name) => fold(name) === wanted));
  if (!matches.length && wanted) matches = members.filter((item) => [...item.names, ...item.nicknames].some((name) => fold(name).startsWith(wanted)));
  if (matches.length !== 1) {
    return { error: matches.length ? `ambigu: ${matches.map((item) => item.names[0]).join(", ")}` : `anggota '${member}' tidak ketemu di grup ini` };
  }
  const target = matches[0];
  const saved = storeNickname(groupId, target.phone, nickname, members);
  if (saved.error) return saved;
  return { ok: true, member: target.names[0], alias: nickname, note: `sekarang '${nickname}' bisa dipakai untuk men-tag ${target.names[0]} (tulis @${nickname})` };
}

// Inti penyimpanan: dipakai remember_alias (diajari langsung) dan belajar diam-diam
// dari ringkasan obrolan (compact) / penulisan ulang memori lama.
function storeNickname(groupId, phone, alias, members) {
  const nickname = String(alias || "").trim().replace(/^@/, "");
  if (!nickname || nickname.length > 30 || !/\p{L}/u.test(nickname)) return { error: "nama panggilan tidak valid" };
  const target = members.find((item) => item.phone === phone);
  if (!target) return { error: "bukan anggota grup ini" };
  // Nama panggilan yang sudah dipakai orang lain di grup ini ditolak (tag jadi ambigu).
  const taken = members.find((item) => item.phone !== phone && [...item.names, ...item.nicknames].some((name) => fold(name) === fold(nickname)));
  if (taken) return { error: `nama '${nickname}' sudah dipakai ${taken.names[0]}` };
  // Sudah sama dengan nama WhatsApp-nya: tidak perlu disimpan.
  if (target.names.some((name) => fold(name) === fold(nickname))) return { ok: true, unchanged: true };
  const person = memoryStore.ensurePerson(phone);
  if (!Array.isArray(person.nicknames)) person.nicknames = [];
  if (!person.nicknames.some((name) => fold(name) === fold(nickname))) {
    person.nicknames.push(nickname);
    if (person.nicknames.length > MAX_NICKNAMES) person.nicknames.splice(0, person.nicknames.length - MAX_NICKNAMES);
    memoryStore.save();
  }
  cache.delete(groupId);
  return { ok: true };
}

/**
 * Belajar nama panggilan tanpa bicara (hasil compact / penulisan ulang memori).
 * Hanya untuk nomor yang memang anggota grup ini; yang ragu/bentrok dilewati.
 * @returns {Array<{ phone, nickname }>} yang tersimpan
 */
async function learnNicknames(groupId, pairs = []) {
  if (!Array.isArray(pairs) || !pairs.length) return [];
  const members = (await groupMembers(groupId, { fresh: true })).filter((item) => item.phone);
  const learned = [];
  for (const pair of pairs.slice(0, 20)) {
    const phone = memoryStore.normalizePhone(pair?.phone);
    const result = storeNickname(groupId, phone, pair?.nickname, members);
    if (result.ok && !result.unchanged) {
      learned.push({ phone, nickname: String(pair.nickname).trim() });
      const member = members.find((item) => item.phone === phone);
      if (member) member.nicknames.push(String(pair.nickname).trim());
    }
  }
  return learned;
}

function reset() {
  cache.clear();
}

module.exports = { cachedMembers, groupMembers, learnNicknames, membersPromptLine, rememberAlias, reset, setGroupMembersProvider };
