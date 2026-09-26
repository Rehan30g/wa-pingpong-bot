// Satu loop agen aktif per chat (Plan v2 §3). Pesan baru di chat yang sama
// disuntikkan ke loop yang sedang berjalan; "stop"/"batal" menghentikannya.
const loops = new Map();

function begin(chatId) {
  const controller = new AbortController();
  const handle = {
    chatId,
    signal: controller.signal,
    injections: [],
    get aborted() { return controller.signal.aborted; },
    inject(entry) {
      if (!controller.signal.aborted) handle.injections.push(entry);
    },
    // Dipanggil loop sebelum langkah berikutnya. Entri yang diambil ditandai
    // absorbed agar evaluasi antreannya tidak membalas dua kali.
    drain() {
      const taken = handle.injections.splice(0);
      for (const entry of taken) entry.absorbed = true;
      return taken;
    },
    abort() {
      controller.abort();
    },
  };
  loops.set(chatId, handle);
  return handle;
}

function get(chatId) {
  return loops.get(chatId) || null;
}

function end(handle) {
  if (handle && loops.get(handle.chatId) === handle) loops.delete(handle.chatId);
}

function abortAll() {
  for (const handle of loops.values()) handle.abort();
  loops.clear();
}

const STOP_CORE = new Set(["stop", "stopp", "stopin", "setop", "berhenti", "batal", "batalin", "batalkan", "cancel", "cukup", "udahan", "gajadi", "gausah"]);
const NEGATION = new Set(["gak", "ga", "nggak", "ngga", "enggak", "engga", "tidak", "ndak", "g"]);
const FILLER = new Set(["aja", "saja", "dulu", "deh", "ya", "yah", "yaa", "dong", "bro", "kak", "bang", "udah", "sudah", "sih", "nih", "please", "plis", "lah", "oke", "ok", "yaudah", "jadi", "usah"]);

// "stop"/"batal" singkat: setiap kata harus kata berhenti, pengisi, nama bot,
// atau mention. "jangan stop dulu, lanjut…" tidak dihitung.
function isStopCommand(text, botName = "") {
  const value = String(text || "").trim().toLowerCase();
  if (!value || value.length > 40) return false;
  const name = String(botName || "").trim().toLowerCase();
  const words = value.replace(/[.,!?:;]+/g, " ").split(/\s+/).filter(Boolean)
    .filter((word) => !word.startsWith("@") && word !== name);
  if (!words.length) return false;
  const negatedJadi = words.includes("jadi") && words.some((word) => NEGATION.has(word));
  const negatedUsah = words.includes("usah") && words.some((word) => NEGATION.has(word));
  if (!words.some((word) => STOP_CORE.has(word)) && !negatedJadi && !negatedUsah) return false;
  return words.every((word) => STOP_CORE.has(word) || FILLER.has(word) || NEGATION.has(word));
}

module.exports = { abortAll, begin, end, get, isStopCommand };
