const fs = require("fs");
const path = require("path");

function getMemoryFile() {
  return path.resolve(process.env.AI_MEMORY_FILE || "./ai-memory.json");
}

const MEMORY_VERSION = 2;
let lastLoadedMemoryFile = null;
let memoryCache = null;

function emptyGroupMemory() {
  return {
    glm: "Belum ada memori terkompresi.",
    jev: "Belum ada konteks keputusan terkompresi.",
    updated_at_wit: null,
    compact_log: [],
  };
}

function emptyDmMemory() {
  return {
    glm: "Belum ada memori DM.",
    jev: "Belum ada konteks keputusan DM.",
    updated_at_wit: null,
    compact_log: [],
    opt_out: false,
    proactive_consent: false,
    proactive_consent_at: null,
    proactive_consent_source: null,
    last_bot_dm_wit: null,
    last_proactive_at: null,
    proactive_day: null,
    proactive_count: 0,
    last_user_dm_at: null,
  };
}

function normalizePhone(value = "") {
  const digits = String(value).split(":")[0].split("@")[0].replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
}

function relationId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("@g.us")) return `group:${raw}`;
  return normalizePhone(raw) ? `person:${normalizePhone(raw)}` : raw;
}

function migrate(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const groups = source.groups && typeof source.groups === "object" && !Array.isArray(source.groups) ? source.groups : {};
  const people = source.people && typeof source.people === "object" && !Array.isArray(source.people) ? source.people : {};
  const relationships = source.relationships && typeof source.relationships === "object" && !Array.isArray(source.relationships) ? source.relationships : {};
  const settings = source.settings && typeof source.settings === "object" && !Array.isArray(source.settings) ? source.settings : {};

  for (const [groupId, value] of Object.entries(groups)) {
    groups[groupId] = {
      ...emptyGroupMemory(),
      ...(value && typeof value === "object" ? value : {}),
      compact_log: Array.isArray(value?.compact_log) ? value.compact_log : [],
    };
  }
  for (const [phone, value] of Object.entries(people)) {
    if (!value || typeof value !== "object") continue;
    people[phone] = { ...value, legacy_profile_scope: value.legacy_profile_scope || "legacy_private", scoped_profiles: value.scoped_profiles && typeof value.scoped_profiles === "object" && !Array.isArray(value.scoped_profiles) ? value.scoped_profiles : {} };
  }
  for (const [key, value] of Object.entries(relationships)) {
    if (!value || typeof value !== "object") continue;
    relationships[key] = { ...value, legacy_scope: value.legacy_scope || "legacy_private", scoped_summaries: value.scoped_summaries && typeof value.scoped_summaries === "object" && !Array.isArray(value.scoped_summaries) ? value.scoped_summaries : {} };
  }
  return { version: MEMORY_VERSION, groups, people, relationships, settings };
}

function load(filePath = getMemoryFile()) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return migrate({});
  try {
    return migrate(JSON.parse(fs.readFileSync(resolved, "utf8")));
  } catch (error) {
    console.warn("[MEM] File memori tidak dapat dibaca, memakai memori kosong:", error.message);
    return migrate({});
  }
}

function reload(filePath = getMemoryFile()) {
  lastLoadedMemoryFile = path.resolve(filePath);
  memoryCache = load(lastLoadedMemoryFile);
  return memoryCache;
}

function getData() {
  const currentFile = getMemoryFile();
  if (currentFile !== lastLoadedMemoryFile || !memoryCache) {
    lastLoadedMemoryFile = currentFile;
    memoryCache = load(currentFile);
  }
  return memoryCache;
}

function save() {
  const engineConfig = require("./runtime/engine-config");
  if (!engineConfig.canWriteProductionMemory() || engineConfig.isShadow()) {
    return;
  }
  const currentFile = getMemoryFile();
  const dir = path.dirname(currentFile);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${currentFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(getData(), null, 2), { mode: 0o600 });
  try {
    fs.renameSync(temp, currentFile);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
      try {
        fs.renameSync(temp, currentFile);
      } catch (retryErr) {
        try { fs.unlinkSync(temp); } catch {}
        throw retryErr;
      }
    } else {
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }
  }
  try {
    fs.chmodSync(currentFile, 0o600);
  } catch {}
}

function getGroupMemory(groupId) {
  return getData().groups[groupId] || emptyGroupMemory();
}

function setGroupMemory(groupId, patch = {}) {
  const previous = getGroupMemory(groupId);
  getData().groups[groupId] = {
    ...previous,
    glm: patch.glm !== undefined ? String(patch.glm).slice(0, 8_000) : previous.glm,
    jev: patch.jev !== undefined ? String(patch.jev).slice(0, 4_000) : previous.jev,
    updated_at_wit: patch.updated_at_wit || previous.updated_at_wit,
    compact_log: patch.compact_log || previous.compact_log,
  };
  save();
  return getData().groups[groupId];
}

function appendGroupCompactLog(groupId, timestamp) {
  const memory = getGroupMemory(groupId);
  memory.compact_log = [...(memory.compact_log || []), timestamp].slice(-20);
  getData().groups[groupId] = memory;
}

function deleteGroupMemory(groupId) {
  delete getData().groups[groupId];
  for (const person of Object.values(getData().people)) {
    if (person?.scoped_profiles && Object.hasOwn(person.scoped_profiles, groupId)) delete person.scoped_profiles[groupId];
  }
  for (const relation of Object.values(getData().relationships)) {
    if (relation?.scoped_summaries && Object.hasOwn(relation.scoped_summaries, groupId)) delete relation.scoped_summaries[groupId];
  }
  save();
}

function normalizedKey(phone) {
  return normalizePhone(phone);
}

function getPerson(phone) {
  const key = normalizedKey(phone);
  if (!key) return null;
  return getData().people[key] || null;
}

function ensurePerson(phone) {
  const key = normalizedKey(phone);
  if (!key) return null;
  if (!getData().people[key]) {
    getData().people[key] = {
      name: null,
      aliases: [],
      groups: [],
      profile: "",
      relation: "",
      legacy_profile_scope: "legacy_private",
      scoped_profiles: {},
      first_seen_wit: null,
      last_seen_wit: null,
      dm: emptyDmMemory(),
    };
  }
  const person = getData().people[key];
  if (!person.dm || typeof person.dm !== "object") person.dm = emptyDmMemory();
  person.dm = { ...emptyDmMemory(), ...person.dm };
  if (!Array.isArray(person.aliases)) person.aliases = [];
  if (!Array.isArray(person.groups)) person.groups = [];
  if (!person.scoped_profiles || typeof person.scoped_profiles !== "object" || Array.isArray(person.scoped_profiles)) person.scoped_profiles = {};
  return person;
}

function getPersonForChat(phone, chatId) {
  const person = getPerson(phone);
  if (!person) return null;
  const scoped = chatId && person.scoped_profiles && Object.hasOwn(person.scoped_profiles, chatId) ? person.scoped_profiles[chatId] : null;
  return { ...person, profile: scoped?.profile || "", relation: scoped?.relation || "" };
}

function recordParticipant({ phone, name, groupId, at } = {}) {
  const key = normalizedKey(phone);
  if (!key || key === "BOT") return null;
  const person = ensurePerson(key);
  if (!person) return null;
  const label = String(name || "").trim();
  if (label && person.name !== label && !person.aliases.includes(label)) {
    if (!person.name) person.name = label;
    else person.aliases.push(label);
  }
  if (groupId && !person.groups.includes(groupId)) person.groups.push(groupId);
  person.first_seen_wit ||= at || null;
  person.last_seen_wit = at || person.last_seen_wit;
  if (!groupId) person.dm.last_user_dm_at = Date.now();
  save();
  return person;
}

function canDirectMessage(phone) {
  const person = getPerson(phone);
  return Boolean(person && Array.isArray(person.groups) && person.groups.length > 0);
}

function listPeople() {
  return Object.entries(getData().people).map(([phone, person]) => ({ phone, ...person }));
}

function mergeText(previous, incoming, maxLength) {
  const oldValue = String(previous || "").trim();
  const newValue = String(incoming || "").trim();
  if (!newValue) return oldValue.slice(0, maxLength);
  if (!oldValue || newValue.includes(oldValue)) return newValue.slice(0, maxLength);
  if (oldValue.includes(newValue)) return oldValue.slice(0, maxLength);
  return `${oldValue}\n${newValue}`.slice(0, maxLength);
}

function upsertPersonProfile(phone, { name, profile, relation, merge = false, sourceChatId = null } = {}) {
  const person = ensurePerson(phone);
  if (!person) return null;
  if (name) person.name = String(name).slice(0, 120);
  if (!sourceChatId && profile) person.profile = merge ? mergeText(person.profile, profile, 4_000) : String(profile).slice(0, 4_000);
  if (!sourceChatId && relation) person.relation = merge ? mergeText(person.relation, relation, 2_000) : String(relation).slice(0, 2_000);
  if (sourceChatId) {
    const previous = person.scoped_profiles[sourceChatId] || { profile: "", relation: "" };
    person.scoped_profiles[sourceChatId] = {
      profile: profile ? (merge ? mergeText(previous.profile, profile, 4_000) : String(profile).slice(0, 4_000)) : previous.profile,
      relation: relation ? (merge ? mergeText(previous.relation, relation, 2_000) : String(relation).slice(0, 2_000)) : previous.relation,
      source_chat_id: sourceChatId,
      updated_at: Date.now(),
    };
  }
  save();
  return person;
}

function getDmMemory(phone) {
  const person = ensurePerson(phone);
  return person ? person.dm : emptyDmMemory();
}

function setDmMemory(phone, patch = {}) {
  const person = ensurePerson(phone);
  if (!person) return emptyDmMemory();
  person.dm = {
    ...person.dm,
    ...patch,
    glm: patch.glm !== undefined ? String(patch.glm).slice(0, 8_000) : person.dm.glm,
    jev: patch.jev !== undefined ? String(patch.jev).slice(0, 4_000) : person.dm.jev,
  };
  if (patch.opt_out === true) {
    person.dm.proactive_consent = false;
    person.dm.proactive_consent_at = null;
    person.dm.proactive_consent_source = null;
  }
  save();
  return person.dm;
}

function noteBotDm(phone, { at, proactive } = {}) {
  const engineConfig = require("./runtime/engine-config");
  if (!engineConfig.canWriteProductionMemory() || engineConfig.isShadow()) {
    return;
  }
  const person = ensurePerson(phone);
  if (!person) return;
  const day = witDay(at);
  if (person.dm.proactive_day !== day) {
    person.dm.proactive_day = day;
    person.dm.proactive_count = 0;
  }
  person.dm.last_bot_dm_wit = at || person.dm.last_bot_dm_wit;
  if (proactive) {
    person.dm.last_proactive_at = at || Date.now();
    person.dm.proactive_count = (person.dm.proactive_count || 0) + 1;
  }
  save();
}

function witDay(at = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jayapura", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function relationshipKey(a, b) {
  const left = relationId(a);
  const right = relationId(b);
  if (!left || !right) return "";
  return [left, right].sort().join("|");
}

function getRelationship(a, b) {
  const key = relationshipKey(a, b);
  return (key && getData().relationships[key]) || null;
}

function getRelationshipForChat(a, b, chatId) {
  const relation = getRelationship(a, b);
  if (!relation || !chatId) return null;
  const summary = relation.scoped_summaries?.[chatId];
  return summary ? { summary, source_chat_id: chatId } : null;
}

function setRelationship(a, b, patch = {}) {
  const key = relationshipKey(a, b);
  if (!key) return null;
  const previous = getData().relationships[key] || {};
  const sourceChatId = patch.sourceChatId || null;
  const scopedSummaries = previous.scoped_summaries && typeof previous.scoped_summaries === "object" && !Array.isArray(previous.scoped_summaries) ? { ...previous.scoped_summaries } : {};
  if (sourceChatId && patch.summary !== undefined) {
    scopedSummaries[sourceChatId] = patch.merge ? mergeText(scopedSummaries[sourceChatId], patch.summary, 2_000) : String(patch.summary).slice(0, 2_000);
  }
  getData().relationships[key] = {
    ...previous,
    summary: !sourceChatId && patch.summary !== undefined
      ? (patch.merge ? mergeText(previous.summary, patch.summary, 2_000) : String(patch.summary).slice(0, 2_000))
      : previous.summary || "",
    scoped_summaries: scopedSummaries,
    updated_at_wit: patch.updated_at_wit || previous.updated_at_wit || null,
  };
  save();
  return getData().relationships[key];
}

function getAgentSettings() {
  return { ...getData().settings };
}

function setAgentSettings(patch = {}) {
  const engineConfig = require("./runtime/engine-config");
  if (!engineConfig.canWriteProductionMemory() || engineConfig.isShadow()) {
    throw new Error("Mode shadow dilarang memanggil API yang menulis memoryStore atau pengaturan agen produksi");
  }
  getData().settings = { ...getData().settings, ...patch };
  save();
  return getAgentSettings();
}

function stats() {
  return {
    groups: Object.keys(getData().groups).length,
    people: Object.keys(getData().people).length,
    relationships: Object.keys(getData().relationships).length,
    dms: Object.values(getData().people).filter((person) => person.dm?.updated_at_wit).length,
  };
}

function resetAllMemory() {
  memoryCache = migrate({});
  save();
}

module.exports = {
  appendGroupCompactLog,
  canDirectMessage,
  deleteGroupMemory,
  emptyDmMemory,
  emptyGroupMemory,
  ensurePerson,
  getDmMemory,
  getAgentSettings,
  getGroupMemory,
  getPerson,
  getPersonForChat,
  getRelationship,
  getRelationshipForChat,
  listPeople,
  migrate,
  normalizePhone,
  noteBotDm,
  recordParticipant,
  relationId,
  resetAllMemory,
  save,
  setDmMemory,
  setAgentSettings,
  setGroupMemory,
  setRelationship,
  stats,
  upsertPersonProfile,
  witDay,
  get MEMORY_FILE() {
    return getMemoryFile();
  },
  getMemoryFile,
  reload,
  MEMORY_VERSION,
};
