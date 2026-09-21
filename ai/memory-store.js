const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.resolve(process.env.AI_MEMORY_FILE || "./ai-memory.json");
const MEMORY_VERSION = 2;

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
    last_bot_dm_wit: null,
    last_proactive_at: null,
    proactive_day: null,
    proactive_count: 0,
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
  return { version: MEMORY_VERSION, groups, people, relationships, settings };
}

function load() {
  if (!fs.existsSync(MEMORY_FILE)) return migrate({});
  try {
    return migrate(JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")));
  } catch (error) {
    console.warn("[MEM] File memori tidak dapat dibaca, memakai memori kosong:", error.message);
    return migrate({});
  }
}

let data = load();

function save() {
  const dir = path.dirname(MEMORY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${MEMORY_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, MEMORY_FILE);
  fs.chmodSync(MEMORY_FILE, 0o600);
}

function getGroupMemory(groupId) {
  return data.groups[groupId] || emptyGroupMemory();
}

function setGroupMemory(groupId, patch = {}) {
  const previous = getGroupMemory(groupId);
  data.groups[groupId] = {
    ...previous,
    glm: patch.glm !== undefined ? String(patch.glm).slice(0, 8_000) : previous.glm,
    jev: patch.jev !== undefined ? String(patch.jev).slice(0, 4_000) : previous.jev,
    updated_at_wit: patch.updated_at_wit || previous.updated_at_wit,
    compact_log: patch.compact_log || previous.compact_log,
  };
  save();
  return data.groups[groupId];
}

function appendGroupCompactLog(groupId, timestamp) {
  const memory = getGroupMemory(groupId);
  memory.compact_log = [...(memory.compact_log || []), timestamp].slice(-20);
  data.groups[groupId] = memory;
}

function deleteGroupMemory(groupId) {
  delete data.groups[groupId];
  save();
}

function normalizedKey(phone) {
  return normalizePhone(phone);
}

function getPerson(phone) {
  const key = normalizedKey(phone);
  if (!key) return null;
  return data.people[key] || null;
}

function ensurePerson(phone) {
  const key = normalizedKey(phone);
  if (!key) return null;
  if (!data.people[key]) {
    data.people[key] = {
      name: null,
      aliases: [],
      groups: [],
      profile: "",
      relation: "",
      first_seen_wit: null,
      last_seen_wit: null,
      dm: emptyDmMemory(),
    };
  }
  const person = data.people[key];
  if (!person.dm || typeof person.dm !== "object") person.dm = emptyDmMemory();
  person.dm = { ...emptyDmMemory(), ...person.dm };
  if (!Array.isArray(person.aliases)) person.aliases = [];
  if (!Array.isArray(person.groups)) person.groups = [];
  return person;
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
  save();
  return person;
}

function canDirectMessage(phone) {
  const person = getPerson(phone);
  return Boolean(person && Array.isArray(person.groups) && person.groups.length > 0);
}

function listPeople() {
  return Object.entries(data.people).map(([phone, person]) => ({ phone, ...person }));
}

function mergeText(previous, incoming, maxLength) {
  const oldValue = String(previous || "").trim();
  const newValue = String(incoming || "").trim();
  if (!newValue) return oldValue.slice(0, maxLength);
  if (!oldValue || newValue.includes(oldValue)) return newValue.slice(0, maxLength);
  if (oldValue.includes(newValue)) return oldValue.slice(0, maxLength);
  return `${oldValue}\n${newValue}`.slice(0, maxLength);
}

function upsertPersonProfile(phone, { name, profile, relation, merge = false } = {}) {
  const person = ensurePerson(phone);
  if (!person) return null;
  if (name) person.name = String(name).slice(0, 120);
  if (profile) person.profile = merge ? mergeText(person.profile, profile, 4_000) : String(profile).slice(0, 4_000);
  if (relation) person.relation = merge ? mergeText(person.relation, relation, 2_000) : String(relation).slice(0, 2_000);
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
  save();
  return person.dm;
}

function noteBotDm(phone, { at, proactive } = {}) {
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
  return (key && data.relationships[key]) || null;
}

function setRelationship(a, b, patch = {}) {
  const key = relationshipKey(a, b);
  if (!key) return null;
  const previous = data.relationships[key] || {};
  data.relationships[key] = {
    ...previous,
    summary: patch.summary !== undefined
      ? (patch.merge ? mergeText(previous.summary, patch.summary, 2_000) : String(patch.summary).slice(0, 2_000))
      : previous.summary || "",
    updated_at_wit: patch.updated_at_wit || previous.updated_at_wit || null,
  };
  save();
  return data.relationships[key];
}

function getAgentSettings() {
  return { ...data.settings };
}

function setAgentSettings(patch = {}) {
  data.settings = { ...data.settings, ...patch };
  save();
  return getAgentSettings();
}

function stats() {
  return {
    groups: Object.keys(data.groups).length,
    people: Object.keys(data.people).length,
    relationships: Object.keys(data.relationships).length,
    dms: Object.values(data.people).filter((person) => person.dm?.updated_at_wit).length,
  };
}

function resetAllMemory() {
  data = migrate({});
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
  getRelationship,
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
  MEMORY_FILE,
  MEMORY_VERSION,
};
