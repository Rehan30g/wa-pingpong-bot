// Memori eksplisit & catatan (Plan v2 M4). Fakta ("inget ya aku alergi udang")
// dan catatan ("catat keputusan rapat") disimpan per chat: yang dibuat di DM
// tidak pernah terlihat di grup, dan sebaliknya. Recall juga mencari di memori
// compact grup supaya fakta hasil compact ikut bisa ditemukan.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FACTS_PER_CHAT = 300;
const MAX_NOTES_PER_CHAT = 50;
const MAX_NOTE_CHARS = 4_000;

function notebookFile() {
  return path.resolve(process.env.NOTEBOOK_FILE || "./data/notebook.json");
}

let cache = null;
let cacheFile = null;

function load() {
  const file = notebookFile();
  if (cache && cacheFile === file) return cache;
  let raw = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn("[MEMORI] notebook.json tidak terbaca, mulai kosong:", error.message);
  }
  cache = { facts: Array.isArray(raw.facts) ? raw.facts : [], notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {} };
  cacheFile = file;
  return cache;
}

function save() {
  const file = notebookFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache, null, 2));
  fs.renameSync(temp, file);
}

const normalize = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const STOP = new Set(["yang", "dan", "di", "ke", "dari", "aku", "saya", "kamu", "itu", "ini", "ya", "apa", "ada", "untuk", "buat", "dengan", "the", "a", "is"]);
const tokens = (text) => normalize(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !STOP.has(t));

function score(queryTokens, text) {
  const haystack = new Set(tokens(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token) || [...haystack].some((word) => word.length > 3 && (word.startsWith(token) || token.startsWith(word)))) hits += 1;
  }
  return hits;
}

const shortId = () => crypto.randomBytes(3).toString("hex");

function factsForChat(chatId) {
  return load().facts.filter((fact) => fact.chatId === chatId);
}

/**
 * Semua operasi terikat pada satu chat. `resolvePerson(name)` (opsional) memetakan
 * nama ke nomor peserta chat itu; `groupMemory()` (opsional) = teks memori compact.
 */
function forChat({ chatId, sender = {}, resolvePerson = () => null, groupMemory = () => "", now = () => Date.now() }) {
  function describeFact(fact) {
    return { id: fact.id, fact: fact.text, about: fact.aboutName, by: fact.byName, at: new Date(fact.at).toISOString().slice(0, 10) };
  }

  return {
    remember({ fact, about = "pengirim" }) {
      const text = String(fact || "").trim().slice(0, 400);
      if (!text) return { error: "fakta kosong" };
      const target = String(about || "").trim();
      let aboutPhone = null;
      let aboutName = target || "pengirim";
      if (!target || /^(pengirim|aku|saya|me|self)$/i.test(target)) {
        aboutPhone = sender.phone || null;
        aboutName = sender.name || "pengirim";
      } else if (/^(grup|group|chat)$/i.test(target)) {
        aboutName = "grup";
      } else {
        const person = resolvePerson(target);
        if (person) {
          aboutPhone = person.phone;
          aboutName = person.name;
        }
      }
      const data = load();
      const duplicate = factsForChat(chatId).find((item) => normalize(item.text) === normalize(text) && item.aboutPhone === aboutPhone);
      if (duplicate) return { ok: true, id: duplicate.id, note: "sudah diingat sebelumnya" };
      const entry = { id: shortId(), chatId, aboutPhone, aboutName, text, byPhone: sender.phone || null, byName: sender.name || null, at: now() };
      data.facts.push(entry);
      const mine = factsForChat(chatId);
      if (mine.length > MAX_FACTS_PER_CHAT) {
        const oldest = mine[0];
        data.facts = data.facts.filter((item) => item !== oldest);
      }
      save();
      return { ok: true, ...describeFact(entry) };
    },

    recall({ query = "" }) {
      const q = tokens(query);
      const facts = factsForChat(chatId)
        .map((fact) => ({ fact, s: q.length ? score(q, `${fact.text} ${fact.aboutName}`) : 1 }))
        .filter((item) => item.s > 0)
        .sort((a, b) => b.s - a.s || b.fact.at - a.fact.at)
        .slice(0, 10)
        .map((item) => describeFact(item.fact));
      const compact = String(groupMemory() || "").split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence && (!q.length || score(q, sentence) > 0))
        .slice(0, 6);
      return { facts, from_compact_memory: compact, note: facts.length || compact.length ? undefined : "tidak ada yang cocok" };
    },

    forget({ id }) {
      const data = load();
      const fact = factsForChat(chatId).find((item) => item.id === String(id || "").trim());
      if (!fact) return { error: "fakta dengan id itu tidak ada di chat ini (pakai recall untuk mencari id)" };
      data.facts = data.facts.filter((item) => item !== fact);
      save();
      return { ok: true, forgotten: fact.text };
    },

    noteWrite({ title, content, mode = "replace" }) {
      const key = String(title || "").trim().slice(0, 80);
      const body = String(content || "").trim();
      if (!key || !body) return { error: "judul dan isi catatan wajib" };
      const data = load();
      const notes = (data.notes[chatId] ||= {});
      const existingKey = Object.keys(notes).find((name) => normalize(name) === normalize(key));
      if (!existingKey && Object.keys(notes).length >= MAX_NOTES_PER_CHAT) return { error: `catatan di chat ini sudah ${MAX_NOTES_PER_CHAT}` };
      const current = existingKey ? notes[existingKey] : null;
      const next = mode === "append" && current ? `${current.content}\n${body}` : body;
      notes[existingKey || key] = { content: next.slice(-MAX_NOTE_CHARS), updatedAt: now(), by: sender.name || null };
      save();
      return { ok: true, title: existingKey || key, chars: notes[existingKey || key].content.length, mode: current ? mode : "baru" };
    },

    noteRead({ title }) {
      const notes = load().notes[chatId] || {};
      const q = tokens(title);
      const [best] = Object.entries(notes)
        .map(([name, note]) => ({ name, note, s: normalize(name) === normalize(title) ? 99 : score(q, `${name} ${note.content.slice(0, 300)}`) }))
        .filter((item) => item.s > 0)
        .sort((a, b) => b.s - a.s || b.note.updatedAt - a.note.updatedAt);
      if (!best) return { error: "catatan tidak ditemukan", titles: Object.keys(notes) };
      return { title: best.name, content: best.note.content, updated: new Date(best.note.updatedAt).toISOString().slice(0, 16), by: best.note.by };
    },

    noteList() {
      const notes = load().notes[chatId] || {};
      return { notes: Object.entries(notes).sort((a, b) => b[1].updatedAt - a[1].updatedAt).map(([name, note]) => ({ title: name, updated: new Date(note.updatedAt).toISOString().slice(0, 16), preview: note.content.slice(0, 80) })) };
    },

    // Fakta ringkas untuk konteks prompt: tentang pengirim dulu, lalu yang terbaru.
    promptFacts(limit = 12) {
      return factsForChat(chatId)
        .sort((a, b) => Number(b.aboutPhone === sender.phone) - Number(a.aboutPhone === sender.phone) || b.at - a.at)
        .slice(0, limit)
        .map((fact) => `[${fact.id}] tentang ${fact.aboutName}: ${fact.text}`);
    },
  };
}

function listForDashboard() {
  const data = load();
  return { facts: data.facts, notes: data.notes };
}

function resetCache() {
  cache = null;
  cacheFile = null;
}

module.exports = { forChat, listForDashboard, resetCache };
