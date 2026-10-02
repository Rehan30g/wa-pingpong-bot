// Pengaturan runtime yang boleh diubah owner dari dashboard (Plan v2 M2c).
// Disimpan di file terpisah (bukan .env) dan diterapkan ke process.env; modul
// lain membaca env setiap kali dipakai, jadi perubahan berlaku tanpa restart.
// Hanya kunci di whitelist ini yang bisa diubah; secret tidak pernah termasuk.
const fs = require("node:fs");
const path = require("node:path");
const activity = require("./observability/activity");

const SETTINGS = {
  AGENT_DAILY_BUDGET_USD: { label: "Budget harian (USD)", group: "Agen", type: "number", min: 0, max: 100, default: 3 },
  AGENT_TASK_BUDGET_USD: { label: "Budget per tugas (USD)", group: "Agen", type: "number", min: 0, max: 5, default: 0.15 },
  AGENT_MAX_STEPS: { label: "Maks langkah per tugas", group: "Agen", type: "integer", min: 1, max: 40, default: 25 },
  AGENT_WEB_SEARCH_RESULTS: { label: "Hasil web search per pencarian", group: "Agen", type: "integer", min: 1, max: 10, default: 5 },
  AI_MAX_REPLY_CHARS: { label: "Panjang maks obrolan", group: "Gaya balasan", type: "integer", min: 80, max: 1000, default: 220 },
  AI_MAX_TASK_REPLY_CHARS: { label: "Panjang maks jawaban informatif", group: "Gaya balasan", type: "integer", min: 200, max: 4000, default: 1500 },
  AUDIO_MODEL: { label: "Model audio", group: "Audio", type: "enum", options: ["google/gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite-preview", "google/gemini-3.8-flash", "xiaomi/mimo-v2.6-flash"], default: "google/gemini-3.1-flash-lite" },
  AUDIO_REASONING_EFFORT: { label: "Thinking model audio", group: "Audio", type: "enum", options: ["off", "minimal", "low"], default: "off" },
  STICKER_CAPACITY: { label: "Kapasitas koleksi stiker", group: "Stiker", type: "integer", min: 10, max: 500, default: 150 },
  STICKER_MAX_PER_HOUR: { label: "Maks stiker per jam per chat", group: "Stiker", type: "integer", min: 0, max: 30, default: 4 },
  STICKER_REACTION_CHANCE: { label: "Peluang reaction → stiker", group: "Stiker", type: "number", min: 0, max: 1, default: 0.5 },
  AGENT_HELP_COOLDOWN_MIN: { label: "Jeda masuk untuk bantuan (menit)", group: "Proaktif", type: "integer", min: 0, max: 120, default: 2 },
  AGENT_SOCIAL_COOLDOWN_MIN: { label: "Jeda nimbrung sosial (menit)", group: "Proaktif", type: "integer", min: 0, max: 600, default: 60 },
  AGENT_SOCIAL_MAX_PER_HOUR: { label: "Maks nimbrung sosial per jam", group: "Proaktif", type: "integer", min: 0, max: 20, default: 1 },
  AGENT_SOCIAL_MIN_MESSAGES: { label: "Nimbrung: min. pesan manusia dalam jendela (grup ramai)", group: "Proaktif", type: "integer", min: 0, max: 50, default: 4 },
  AGENT_SOCIAL_WINDOW_MIN: { label: "Nimbrung: jendela 'grup ramai' (menit)", group: "Proaktif", type: "integer", min: 1, max: 120, default: 10 },
  AGENT_SOCIAL_MUTE_HOURS: { label: "Lama diam setelah diminta (jam)", group: "Proaktif", type: "number", min: 0, max: 48, default: 3 },
  AGENT_PROACTIVE_CONFIDENCE: { label: "Keyakinan minimum Jev untuk masuk sendiri", group: "Proaktif", type: "number", min: 0, max: 1, default: 0.6 },
  PYTHON_TIMEOUT_MS: { label: "Batas waktu run_python (ms)", group: "Python", type: "integer", min: 5000, max: 300000, default: 60000 },
  PYTHON_MAX_REQUESTS: { label: "Maks request internet per run", group: "Python", type: "integer", min: 0, max: 100, default: 20 },
  AI_AGENT_QUIET_START: { label: "Jam tenang mulai (WIT)", group: "Jadwal", type: "integer", min: 0, max: 23, default: 22 },
  AI_AGENT_QUIET_END: { label: "Jam tenang selesai (WIT)", group: "Jadwal", type: "integer", min: 0, max: 23, default: 7 },
};

function settingsFile() {
  return path.resolve(process.env.RUNTIME_SETTINGS_FILE || "./data/runtime-settings.json");
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function validate(key, value) {
  const spec = SETTINGS[key];
  if (!spec) return { error: "pengaturan_tidak_dikenal" };
  if (spec.type === "enum") return spec.options.includes(value) ? { value } : { error: "nilai_tidak_valid" };
  const number = Number(value);
  if (!Number.isFinite(number) || (spec.type === "integer" && !Number.isInteger(number))) return { error: "nilai_tidak_valid" };
  if (number < spec.min || number > spec.max) return { error: `di_luar_batas_${spec.min}_${spec.max}` };
  return { value: number };
}

// Dipanggil sekali saat start (setelah dotenv): nilai dashboard menimpa .env.
function applySavedSettings() {
  const saved = readFile();
  for (const [key, value] of Object.entries(saved)) {
    const checked = validate(key, value);
    if (!checked.error) process.env[key] = String(checked.value);
  }
  return saved;
}

function currentValue(key) {
  const raw = process.env[key];
  if (raw === undefined || String(raw).trim() === "") return SETTINGS[key].default;
  return SETTINGS[key].type === "enum" ? raw : Number(raw);
}

function listSettings() {
  const saved = readFile();
  return Object.entries(SETTINGS).map(([key, spec]) => ({
    key, ...spec, value: currentValue(key), overridden: Object.prototype.hasOwnProperty.call(saved, key),
  }));
}

function setSetting(key, value, { by = "dashboard" } = {}) {
  const checked = validate(key, value);
  if (checked.error) return { ok: false, error: checked.error };
  const before = currentValue(key);
  const saved = readFile();
  saved[key] = checked.value;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(saved, null, 2));
  process.env[key] = String(checked.value);
  activity.record("setting", { key, from: before, to: checked.value, by });
  return { ok: true, before, after: checked.value };
}

module.exports = { SETTINGS, applySavedSettings, listSettings, setSetting };
