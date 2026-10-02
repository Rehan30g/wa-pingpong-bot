// Rem obrolan tidak senonoh (keputusan owner 2 Okt 2026). Kasus nyata grup
// "Ghost hunter emas": member mulai bercanda mesum dan Grad ikut jadi "enjoyer"
// (ketawa, stiker, celetukan nyambung). Persona saja tidak cukup karena aturan
// "playful/ikut seru-seruan" ikut terbaca, jadi kode juga mengerem:
//  - tidak dipanggil → reaction/stiker/nimbrung ditahan, gantinya tegur halus
//    sesekali (cooldown per grup) yang tetap boleh dibatalkan GLM lewat stay_silent;
//  - dipanggil → GLM diberi catatan konteks dan stiker koleksi tidak ditawarkan.
// Deteksi sengaja kata kunci (tanpa panggilan model): murah, dan salah tangkap
// hanya berarti Grad lebih kalem, karena tegurannya sendiri dinilai ulang GLM.

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function decencyConfig() {
  return {
    windowMs: Math.max(1, envNumber("AGENT_DECENCY_WINDOW_MIN", 15)) * 60_000,
    lookback: Math.max(1, envNumber("AGENT_DECENCY_LOOKBACK", 6)),
    nudgeCooldownMs: Math.max(0, envNumber("AGENT_DECENCY_COOLDOWN_MIN", 30)) * 60_000,
  };
}

// Kata dibandingkan setelah huruf berulang diringkas ("sangeee" → "sange") dan
// angka gaya leet diganti huruf ("s4nge"). Kata ambigu (tete, nenen, ml, bo,
// seksi = bagian panitia) sengaja tidak dimasukkan.
const LEWD_WORDS = [
  "ngentot", "ngentod", "entot", "ngewe", "ewean", "coli", "colmek", "sange", "sangean", "horny",
  "bokep", "porno", "porn", "pornografi", "memek", "kontol", "titit", "toket", "pentil", "ngaceng",
  "crot", "bugil", "telanjang", "mesum", "cabul", "perkosa", "diperkosa", "memperkosa", "perkos",
  "onani", "masturbasi", "vcs", "seks", "sex", "bdsm", "nude", "nudes", "desah", "desahan", "jav",
];
const LEWD_PHRASES = [/\bopen\s+bo\b/, /\bpap\s+(tt|toket|bugil|nude)/, /\b18\s*\+/];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[4@]/g, "a").replace(/3/g, "e").replace(/[1!]/g, "i").replace(/0/g, "o").replace(/5/g, "s")
    .replace(/(\p{L})\1+/gu, "$1");
}

const WORD_SET = new Set(LEWD_WORDS.map(normalize));

function isLewd(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (LEWD_PHRASES.some((pattern) => pattern.test(raw.toLowerCase()))) return true;
  return normalize(raw).split(/[^\p{L}]+/u).some((word) => word && WORD_SET.has(word));
}

/**
 * Status obrolan dari riwayat (pesan manusia terbaru saja, dalam jendela waktu).
 * `warned` = Grad sudah bicara setelah pesan mesum pertama di jendela itu
 * (menegur/menolak), jadi desakan berikutnya cukup didiamkan.
 * @returns {{ active: boolean, latest: boolean, count: number, warned: boolean }}
 */
function lewdContext(history = [], at = Date.now()) {
  const cfg = decencyConfig();
  const humans = history.filter((item) => !item.is_bot && item.sender_id !== "SCHEDULER").slice(-cfg.lookback);
  const recent = humans.filter((item) => !Number(item.at) || at - Number(item.at) <= cfg.windowMs);
  const lewd = recent.filter((item) => isLewd(item.text));
  const last = humans.at(-1);
  const firstIndex = lewd.length ? history.indexOf(lewd[0]) : -1;
  const warned = firstIndex >= 0 && history.slice(firstIndex + 1).some((item) => item.is_bot);
  return { active: lewd.length > 0, latest: Boolean(last && recent.includes(last) && isLewd(last.text)), count: lewd.length, warned };
}

const nudges = new Map(); // groupId -> waktu teguran terakhir

function checkNudge(groupId, at = Date.now()) {
  const last = nudges.get(groupId) || 0;
  return at - last >= decencyConfig().nudgeCooldownMs ? { ok: true } : { ok: false, reason: "cooldown" };
}

function markNudge(groupId, at = Date.now()) {
  nudges.set(groupId, at);
}

function reset() {
  nudges.clear();
}

// Catatan untuk prompt saat Grad DIPANGGIL di tengah obrolan seperti ini.
// Validasi 2 Okt: dengan "alihkan" saja GLM mengarang topik pengalih ("ada warung
// bakso enak deket sini, mau share lokasinya?") dan menutup dengan tawaran.
const DECENCY_NOTE = "Catatan konteks: obrolan barusan mengarah ke hal seksual/tidak senonoh. Jangan ikut bercanda, jangan menambah plesetan, jangan ketawa atau kirim emoji tawa. Kalau pesan untukmu memancing ke arah itu, tolak halus SATU kalimat pendek dengan gayamu (aku–kamu), tanpa mengarang topik pengalih, tanpa tawaran atau pertanyaan balik. Pertanyaan lain yang tidak terkait, atau pertanyaan serius soal kesehatan/pendidikan, tetap dijawab biasa tanpa mengomentari bahwa pertanyaannya serius.";

// Grad sudah menegur/menolak di obrolan ini: desakan berikutnya didiamkan.
const WARNED_NOTE = "Kamu SUDAH menegur/menolak di obrolan mesum ini. Kalau pesan terbaru masih memancing ke arah itu (termasuk 'jangan sok suci', 'dikit aja'), WAJIB panggil stay_silent dan jangan menulis apa pun. Hanya kalau pesan terbaru jelas berganti ke topik lain yang wajar, jawab biasa.";

function promptNote(context) {
  if (!context?.active) return "";
  return context.warned ? `${DECENCY_NOTE} ${WARNED_NOTE}` : DECENCY_NOTE;
}

// Arahan saat Grad TIDAK dipanggil tapi masuk untuk menegur.
const NUDGE_HINT = "PENTING: kamu TIDAK dipanggil. Kamu masuk sendiri karena obrolan barusan mulai mengarah ke hal seksual/tidak senonoh. Tegur halus SATU kalimat super pendek gaya chat: santai dan tetap ramah, tapi jelas kamu tidak ikut (misalnya arahnya 'udah ah, ganti topik yuk'). Tanpa ceramah, tanpa mengulang kata joroknya, tanpa menyebut nama atau men-tag orang, tanpa 'wkwk'/emoji tawa, tanpa stiker. Kalau ternyata itu bukan obrolan mesum (mis. pertanyaan serius soal kesehatan, atau kata yang salah paham), panggil stay_silent.";

// Reaction yang terbaca "ikut menikmati" di obrolan mesum.
const ENJOYING_REACTIONS = new Set(["😂", "🔥", "❤️", "👏", "😮"]);

module.exports = { DECENCY_NOTE, ENJOYING_REACTIONS, WARNED_NOTE, promptNote, NUDGE_HINT, checkNudge, decencyConfig, isLewd, lewdContext, markNudge, reset };
