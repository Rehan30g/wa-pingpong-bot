// Skill = "resep" tugas tertentu dalam Markdown (mirip SKILL.md): frontmatter
// singkat + langkah kerja. Prompt hanya memuat indeks (nama + kapan dipakai);
// isi lengkap baru dimuat lewat tool use_skill, jadi prompt tetap ringan.
// Sumber: skill bawaan (ai/skills/builtin) + skill tambahan owner di SKILLS_DIR
// (default data/skills) yang boleh menimpa bawaan dengan nama sama.
// Skill ditulis owner/pengembang, bukan pengguna chat, jadi isinya dipercaya.
const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_DIR = path.join(__dirname, "builtin");
const NAME_RE = /^[a-z0-9_]{2,40}$/;
const MAX_BODY = 6_000;

function customDir() {
  return path.resolve(process.env.SKILLS_DIR || "./data/skills");
}

// Frontmatter sederhana `kunci: nilai`; requires = daftar fitur dipisah koma.
function parseSkill(raw, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw));
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (pair) meta[pair[1]] = pair[2].trim();
  }
  const name = String(meta.name || "").toLowerCase();
  const body = match[2].trim();
  if (!NAME_RE.test(name) || !meta.description || !body) return null;
  return {
    name,
    title: meta.title || name,
    description: meta.description.slice(0, 200),
    requires: String(meta.requires || "").split(",").map((item) => item.trim()).filter(Boolean),
    body: body.slice(0, MAX_BODY),
    source,
  };
}

function readDir(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      try {
        return parseSkill(fs.readFileSync(path.join(dir, file), "utf8"), source);
      } catch (error) {
        console.warn(`[SKILL] ${file} tidak terbaca:`, error.message);
        return null;
      }
    })
    .filter(Boolean);
}

let cache = null;

// Dibaca ulang tiap 30 detik supaya skill owner baru terpakai tanpa restart.
function allSkills() {
  if (cache && Date.now() - cache.at < 30_000 && cache.dir === customDir()) return cache.skills;
  const byName = new Map();
  for (const skill of [...readDir(BUILTIN_DIR, "bawaan"), ...readDir(customDir(), "owner")]) byName.set(skill.name, skill);
  cache = { at: Date.now(), dir: customDir(), skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  return cache.skills;
}

// features: Set fitur aktif di chat (null = semua). Skill hanya muncul bila
// semua fitur yang dibutuhkannya aktif, jadi tidak menawarkan hal yang mati.
function skillsFor(features = null) {
  return allSkills().filter((skill) => skill.requires.every((name) => !features || features.has(name)));
}

function indexText(features = null) {
  return skillsFor(features).map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

function getSkill(name, features = null) {
  const wanted = String(name || "").trim().toLowerCase();
  return skillsFor(features).find((skill) => skill.name === wanted) || null;
}

// Kontrol untuk toolContext agent loop (null bila tidak ada skill yang bisa dipakai).
function forFeatures(features = null) {
  const list = skillsFor(features);
  if (!list.length) return null;
  return {
    names: () => list.map((skill) => skill.name),
    get: (name) => list.find((skill) => skill.name === String(name || "").trim().toLowerCase()) || null,
    index: list.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
  };
}

function resetCache() {
  cache = null;
}

module.exports = { allSkills, forFeatures, getSkill, indexText, parseSkill, resetCache, skillsFor };
