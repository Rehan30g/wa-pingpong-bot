// Katalog tools agent loop (Plan v2 §4, M1). Kontrak: schema JSON untuk model,
// handler, timeout, dan hasil ringkas. Tujuan pengiriman tidak pernah datang
// dari argumen model: tools di sini hanya membaca, bukan mengirim.
const Ajv = require("ajv");
const { safeWebFetch } = require("../runtime/safe-web-fetch");
const { redactString } = require("../observability/redact");
const ears = require("../audio/ears");

const ajv = new Ajv({ allErrors: false, strict: false });
let webFetcher = safeWebFetch;

// Untuk tes: ganti fetcher jaringan dengan stub.
function setWebFetcher(fn) {
  webFetcher = fn || safeWebFetch;
}

function webSearchEnabled() {
  return process.env.AGENT_WEB_SEARCH !== "false";
}

// web_search adalah server tool bawaan OpenRouter: dieksekusi di sisi OpenRouter
// dalam request GLM yang sama, jadi tidak punya handler lokal.
function webSearchServerTool() {
  const maxResults = Math.min(10, Math.max(1, Number(process.env.AGENT_WEB_SEARCH_RESULTS) || 5));
  return { type: "openrouter:web_search", parameters: { max_results: maxResults } };
}

const TOOLS = {
  web_fetch: {
    description: "Baca isi teks sebuah halaman web (https) dari URL yang dikirim pengguna atau dari hasil pencarian. Pakai untuk merangkum/menjawab dari link tertentu.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL https lengkap" } },
      required: ["url"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    async handler({ url }, ctx) {
      const result = await (ctx.fetcher || webFetcher)(url, {
        allowedHosts: "*",
        allowQuery: true,
        decompress: true,
        maxBytes: 3 * 1_048_576,
        timeoutMs: 12_000,
        maxRedirects: 4,
        maxChars: 9_000,
        signal: ctx.signal,
      });
      return { url: result.url, title: result.title || "", text: redactString(result.text) };
    },
  },

  listen_audio: {
    description: "Tanya sesuatu yang spesifik tentang voice note/audio di riwayat chat (misalnya lagu apa, nada bicaranya, angka/tanggal yang disebut). entry_id adalah nomor # pesan voice note, atau pesan yang me-reply voice note. Transkrip dasar sudah ada di riwayat; pakai ini hanya bila butuh detail lebih.",
    parameters: {
      type: "object",
      properties: {
        entry_id: { type: "integer", description: "nomor # pesan di riwayat" },
        question: { type: "string", description: "pertanyaan untuk pendengar audio" },
        context: { type: "string", description: "konteks singkat yang membantu pendengar (opsional)" },
      },
      required: ["entry_id", "question"],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    async handler({ entry_id: entryId, question, context = "" }, ctx) {
      const entry = (ctx.getHistory?.() || []).find((item) => item.entry_id === entryId);
      if (!entry) return { error: `pesan #${entryId} tidak ada di riwayat aktif` };
      if (!entry.audio?.mp3) return { error: `pesan #${entryId} tidak membawa audio yang masih tersimpan` };
      const heard = await (ctx.listen || ears.listen)({ mp3: entry.audio.mp3, question: String(question).slice(0, 500), context: String(context).slice(0, 500), botName: ctx.botName });
      ctx.addCost?.(heard.cost || 0);
      return { entry_id: entryId, answer: heard.answer, note: "Jawaban pendengar audio; judul lagu hanyalah tebakan dan perlu diverifikasi." };
    },
  },
};

TOOLS.send_sticker = {
  description: "Kirim satu stiker dari koleksimu (lihat daftar 'Koleksi stiker') ke chat ini. placement 'only' = stiker menggantikan balasan (jawaban akhirmu harus kosong: tanpa teks, tanpa emoji); pakai ini kalau pengguna cuma minta dikirimi/dipakaikan stiker; 'after_text' = stiker dikirim setelah balasan teksmu. Pakai kalau memang cocok dan terasa natural, jangan setiap balasan.",
  parameters: {
    type: "object",
    properties: {
      sticker_id: { type: "string", description: "id stiker dari daftar koleksi" },
      placement: { type: "string", enum: ["only", "after_text"] },
    },
    required: ["sticker_id", "placement"],
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler({ sticker_id: stickerId, placement }, ctx) {
    const stickers = ctx.stickers;
    const sticker = stickers?.usable?.get(String(stickerId).trim().toLowerCase().slice(0, 8));
    if (!sticker) return { error: "stiker tidak ada di koleksi yang boleh dipakai di chat ini sekarang" };
    if (stickers.queue.length) return { error: "satu stiker per balasan sudah cukup" };
    // Tujuan kirim tetap chat asal; tool hanya mengantrekan, pengiriman oleh runtime.
    stickers.queue.push({ ...sticker, placement });
    return { ok: true, queued: sticker.id, label: sticker.label, placement, note: placement === "only" ? "jawaban akhirmu harus kosong (tanpa teks/emoji)" : "tulis balasan teksmu, stiker dikirim sesudahnya" };
  },
};

TOOLS.save_sticker = {
  description: "Simpan stiker yang diminta pengguna ke koleksimu (misalnya 'grad simpan stiker ini' sambil me-reply stiker). entry_id = nomor # pesan stiker itu, atau pesan yang me-reply stiker. Lihat dulu stikernya (terlampir, atau lewat get_chat_media) dan nilai keamanannya dengan jujur. Setelah tersimpan, stiker langsung bisa kamu kirim dengan send_sticker.",
  parameters: {
    type: "object",
    properties: {
      entry_id: { type: "integer" },
      label: { type: "string", description: "makna singkat, maks 6 kata" },
      moods: { type: "array", items: { type: "string", enum: ["laugh", "ack", "sad", "tease", "love", "confused", "hype", "shock", "tired", "angry", "thanks", "greet"] } },
      when_to_use: { type: "string" },
      planned_frequency: { type: "string", enum: ["sering", "kadang", "jarang"] },
      scope: { type: "string", enum: ["global", "local"], description: "local bila ada wajah/nama orang nyata atau lelucon internal; ragu = local" },
      safety: { type: "string", enum: ["ok", "nsfw", "sara", "demeaning"] },
      replace_sticker_id: { type: "string", description: "opsional: id stiker koleksi yang dibuang bila koleksi penuh" },
    },
    required: ["entry_id", "label", "moods", "when_to_use", "planned_frequency", "scope", "safety"],
    additionalProperties: false,
  },
  timeoutMs: 20_000,
  async handler(args, ctx) {
    if (!ctx.saveSticker) return { error: "menyimpan stiker tidak tersedia di chat ini" };
    return ctx.saveSticker(args);
  },
};

TOOLS.schedule = {
  description: "Buat pengingat atau tugas terjadwal di chat ini. kind 'reminder' = kirim teks pengingat pada waktunya; kind 'task' = pada waktunya kamu menjalankan permintaan itu (mis. cari berita/jadwal) lalu kirim hasilnya. at = waktu WIT 'YYYY-MM-DD HH:MM' (hitung dari waktu sekarang). repeat none/daily/weekly; days untuk weekly (1=Senin … 7=Minggu).",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["reminder", "task"] },
      text: { type: "string", description: "isi pengingat (sapaan natural) atau permintaan tugas" },
      at: { type: "string", description: "YYYY-MM-DD HH:MM (WIT)" },
      repeat: { type: "string", enum: ["none", "daily", "weekly"] },
      days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } },
    },
    required: ["kind", "text", "at", "repeat"],
    additionalProperties: false,
  },
  timeoutMs: 3_000,
  async handler(args, ctx) {
    return ctx.schedules ? ctx.schedules.create(args) : { error: "jadwal tidak tersedia di chat ini" };
  },
};

TOOLS.list_schedules = {
  description: "Lihat jadwal/pengingat yang aktif di chat ini (id, isi, waktu berikutnya, perulangan).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  timeoutMs: 2_000,
  async handler(_args, ctx) {
    return ctx.schedules ? ctx.schedules.list() : { error: "jadwal tidak tersedia di chat ini" };
  },
};

TOOLS.cancel_schedule = {
  description: "Batalkan jadwal di chat ini berdasarkan id (lihat list_schedules dulu kalau belum tahu id-nya).",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  timeoutMs: 2_000,
  async handler(args, ctx) {
    return ctx.schedules ? ctx.schedules.cancel(args) : { error: "jadwal tidak tersedia di chat ini" };
  },
};

const notebookTool = (description, parameters, method) => ({
  description,
  parameters: { type: "object", properties: parameters.properties || {}, required: parameters.required || [], additionalProperties: false },
  timeoutMs: 3_000,
  async handler(args, ctx) {
    return ctx.notebook ? ctx.notebook[method](args) : { error: "memori tidak tersedia di chat ini" };
  },
});

TOOLS.remember = notebookTool(
  "Simpan fakta penting yang diminta atau jelas berguna nanti (preferensi, alergi, ulang tahun, keputusan). about: 'pengirim', 'grup', atau nama peserta.",
  { properties: { fact: { type: "string" }, about: { type: "string" } }, required: ["fact"] },
  "remember",
);
TOOLS.recall = notebookTool(
  "Cari fakta yang pernah kamu ingat di chat ini (juga memori ringkasan grup). Pakai sebelum menjawab hal pribadi/preferensi yang tidak ada di konteks.",
  { properties: { query: { type: "string" } }, required: ["query"] },
  "recall",
);
TOOLS.forget = notebookTool(
  "Hapus fakta yang diminta dilupakan (id dari recall atau daftar fakta di konteks).",
  { properties: { id: { type: "string" } }, required: ["id"] },
  "forget",
);
TOOLS.note_write = notebookTool(
  "Tulis/perbarui catatan chat ini (mis. keputusan rapat, daftar tugas). mode 'append' menambah ke catatan yang ada, 'replace' menimpa.",
  { properties: { title: { type: "string" }, content: { type: "string" }, mode: { type: "string", enum: ["replace", "append"] } }, required: ["title", "content"] },
  "noteWrite",
);
TOOLS.note_read = notebookTool("Baca catatan chat ini berdasarkan judul (boleh perkiraan).", { properties: { title: { type: "string" } }, required: ["title"] }, "noteRead");
TOOLS.note_list = notebookTool("Daftar catatan di chat ini.", {}, "noteList");

TOOLS.summarize_history = {
  description: "Ambil seluruh riwayat aktif + memori ringkasan chat ini untuk merangkum obrolan (mis. 'rangkum obrolan tadi', 'catat keputusan rapat tadi').",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  timeoutMs: 2_000,
  async handler(_args, ctx) {
    const history = (ctx.getHistory?.() || []).map((item) => `#${item.entry_id} ${item.sender}: ${String(item.text).slice(0, 400)}`);
    return { active_history: history.slice(-80), compact_memory: String(ctx.compactMemory?.() || "").slice(0, 4_000) };
  },
};

TOOLS.run_python = {
  description: "Jalankan Python 3 di sandbox (numpy, pandas, matplotlib, pillow, sympy, qrcode). Pakai untuk hitungan presisi, olah data, grafik/gambar, QR, atau memanggil API web: `import net; r = net.get(url, params={...}); r.json()` (juga net.post(url, json=...)). Simpan gambar ke folder out/ (mis. plt.savefig('out/grafik.png'), qrcode.make(teks).save('out/qr.png')) — semua gambar di out/ otomatis dikirim ke chat tepat DI BAWAH jawaban teksmu (jadi rujuk sebagai 'di bawah', dan jangan tulis ulang isinya). File lain di folder kerja tetap tersimpan untuk chat ini. print() hasil yang kamu butuhkan; ekspresi terakhir juga dikembalikan.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "kode Python lengkap" } },
    required: ["code"],
    additionalProperties: false,
  },
  timeoutMs: 90_000,
  async handler({ code }, ctx) {
    if (!ctx.python) return { error: "sandbox Python tidak tersedia di chat ini" };
    const run = await ctx.python.run({ code });
    if (run.images?.length && ctx.outbox) {
      // File yang sama ditimpa run berikutnya: kirim sekali saja (versi terbaru).
      const paths = new Set(run.images.map((image) => image.path));
      ctx.outbox.media = ctx.outbox.media.filter((item) => !paths.has(item.path)).concat(run.images.map((image) => ({ ...image, kind: "image" })));
    }
    return {
      ok: run.ok,
      result: run.result ?? null,
      stdout: String(run.stdout || "").slice(0, 4_000),
      stderr: String(run.stderr || "").slice(0, 1_000),
      error: run.error || null,
      images_to_send: (run.images || []).map((image) => image.name),
      files: run.files || [],
    };
  },
};

const MEDIA_OPS = ["trim", "speed", "resize", "crop_square", "reverse", "mute", "text", "concat"];
TOOLS.media_edit = {
  description: "Olah video/GIF/audio/gambar/stiker dengan FFmpeg. sources: media dari pesan riwayat ({entry_id}: pesan media atau pesan yang me-reply media) atau file workspace ({file}); lebih dari satu sumber = digabung berurutan. steps (opsional, berurutan): trim{start,end} (detik atau mm:ss), speed{factor 0.25–4}, resize{width}, crop_square, reverse (≤30 dtk), mute, text{text, position top|center|bottom, size}, concat. output: sticker (stiker WA, animasi maks 6 dtk), gif, mp4, compress (mp4 dikecilkan ke target_mb), mp3 (ambil audio), frames (beberapa gambar, jumlah=frames). Hasil otomatis dikirim ke chat di bawah jawabanmu.",
  parameters: {
    type: "object",
    properties: {
      sources: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: { entry_id: { type: "integer" }, file: { type: "string" } }, additionalProperties: false } },
      steps: { type: "array", maxItems: 8, items: { type: "object", properties: { op: { type: "string", enum: MEDIA_OPS }, start: { type: ["string", "number"] }, end: { type: ["string", "number"] }, factor: { type: "number" }, width: { type: "integer" }, text: { type: "string" }, position: { type: "string", enum: ["top", "center", "bottom"] }, size: { type: "integer" } }, required: ["op"], additionalProperties: false } },
      output: { type: "string", enum: ["sticker", "gif", "mp4", "compress", "mp3", "frames"] },
      frames: { type: "integer", minimum: 1, maximum: 8 },
      target_mb: { type: "number", minimum: 1, maximum: 15 },
    },
    required: ["sources", "output"],
    additionalProperties: false,
  },
  timeoutMs: 240_000,
  async handler(args, ctx) {
    if (!ctx.mediaEditor) return { error: "edit media tidak tersedia di chat ini" };
    try {
      const result = await ctx.mediaEditor(args);
      if (result.error) return result;
      ctx.outbox?.media.push(...result.files);
      return { ok: true, sent_below: result.files.map((f) => `${f.kind}: ${f.name} (${Math.round(f.size / 1024)} KB)`), info: result.info };
    } catch (error) {
      return { error: String(error.message).slice(0, 300) };
    }
  },
};

TOOLS.send_to_my_dm = {
  description: "Kirim ke chat pribadi (DM) si peminta sendiri, hanya kalau dia memintanya (mis. 'kirim ke DM aku aja', 'japri aku hasilnya'). text = isi pesan DM (boleh kosong bila hanya memindahkan hasil); include_results = true untuk memindahkan gambar/video/audio hasil tugas ini ke DM, bukan ke grup. Tidak bisa ke orang lain atau grup lain.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" }, include_results: { type: "boolean" } },
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler({ text = "", include_results: includeResults = false }, ctx) {
    if (!ctx.dmRelay) return { error: "DM ke peminta tidak tersedia di sini" };
    const body = String(text || "").trim().slice(0, 3_000);
    if (!body && !includeResults) return { error: "tidak ada yang dikirim" };
    if (body) ctx.dmRelay.texts.push(body);
    if (includeResults) ctx.dmRelay.moveResults = true;
    return { ok: true, note: "akan dikirim ke DM peminta setelah balasanmu; di grup cukup bilang singkat bahwa sudah dikirim ke DM" };
  },
};

TOOLS.start_background_task = {
  description: "Serahkan tugas yang kemungkinan lama (riset mendalam dari banyak sumber, perbandingan besar, olah data + grafik, > ~1 menit) ke subagent latar. Chat tidak perlu menunggu: setelah memanggil ini, jawab singkat bahwa kamu sedang mengerjakannya dan akan mengabari. Hasilnya dikirim otomatis ke chat ini sambil me-reply permintaannya. Jangan pakai untuk pertanyaan cepat.",
  parameters: {
    type: "object",
    properties: { goal: { type: "string", description: "tugas lengkap dan jelas untuk subagent, termasuk bentuk hasil yang diinginkan" } },
    required: ["goal"],
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler({ goal }, ctx) {
    return ctx.background ? ctx.background.start({ goal }) : { error: "tugas latar tidak tersedia di sini" };
  },
};

TOOLS.background_tasks = {
  description: "Lihat tugas latar yang sedang berjalan di chat ini, atau batalkan (action cancel + id) kalau diminta.",
  parameters: {
    type: "object",
    properties: { action: { type: "string", enum: ["list", "cancel"] }, id: { type: "string" } },
    required: ["action"],
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler({ action, id }, ctx) {
    if (!ctx.background) return { error: "tugas latar tidak tersedia di sini" };
    return action === "cancel" ? ctx.background.cancel(id) : { tasks: ctx.background.list() };
  },
};

TOOLS.get_chat_media = {
  description: "Ambil gambar/stiker/frame video dari pesan di riwayat (nomor #) supaya bisa kamu lihat dan analisis, terutama media lama yang tidak lagi terlampir.",
  parameters: {
    type: "object",
    properties: { entry_id: { type: "integer", description: "nomor # pesan yang membawa media" } },
    required: ["entry_id"],
    additionalProperties: false,
  },
  timeoutMs: 30_000,
  async handler({ entry_id: entryId }, ctx) {
    const entry = (ctx.getHistory?.() || []).find((item) => item.entry_id === entryId);
    if (!entry) return { error: `pesan #${entryId} tidak ada di riwayat aktif` };
    let media = entry.media;
    if (!media && entry.message_ref && (entry.has_image || entry.has_video || entry.media_kind) && ctx.loadMedia) media = await ctx.loadMedia(entry.message_ref);
    const part = media && ctx.mediaPart?.(media);
    if (!part) return { error: `pesan #${entryId} tidak membawa gambar yang bisa diambil` };
    ctx.attachments = [...(ctx.attachments || []), { label: `Media dari pesan #${entryId} (${entry.sender}: ${String(entry.text).slice(0, 80)})`, part }];
    return { ok: true, entry_id: entryId, kind: media.kind || media.type, note: "media terlampir di pesan berikutnya" };
  },
};

TOOLS.use_skill = {
  description: "Muat langkah kerja lengkap sebuah skill dari daftar 'Skill' di instruksi. Panggil SEKALI di awal tugas yang cocok, lalu ikuti langkahnya dengan tools lain.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "nama skill persis dari daftar" } },
    required: ["name"],
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  // Isi skill ditulis owner/pengembang (bukan pengguna chat), jadi boleh diikuti.
  trusted: true,
  async handler({ name }, ctx) {
    const skill = ctx.skills?.get(name);
    if (!skill) return { error: `skill '${name}' tidak ada atau fiturnya mati di chat ini`, available: ctx.skills?.names() || [] };
    return { skill: skill.name, title: skill.title, instructions: skill.body };
  },
};

for (const tool of Object.values(TOOLS)) tool.validate = ajv.compile(tool.parameters);

// Fitur M2b yang menaungi tiap tool. ctx.features (Set) kosong/absen = semua boleh.
const TOOL_FEATURE = { web_fetch: "web", listen_audio: "audio", send_sticker: "stiker", save_sticker: "stiker", get_chat_media: "media", schedule: "reminder", list_schedules: "reminder", cancel_schedule: "reminder",
  run_python: "python",
  media_edit: "edit_media",
  send_to_my_dm: null,
  start_background_task: "latar",
  background_tasks: "latar",
  use_skill: "skill",
  remember: "memori", recall: "memori", forget: "memori", note_write: "memori", note_read: "memori", note_list: "memori", summarize_history: "memori" };

function featureOn(ctx, feature) {
  return !ctx.features || ctx.features.has(feature);
}

function toolNamesFor(ctx = {}) {
  return Object.keys(TOOLS).filter((name) => {
    if (TOOL_FEATURE[name] && !featureOn(ctx, TOOL_FEATURE[name])) return false;
    if (name === "listen_audio") return Boolean(ctx.hasAudio);
    // send_sticker juga ditawarkan bila ada stiker yang bisa disimpan lalu langsung dipakai.
    if (name === "send_sticker") return Boolean(ctx.stickers && (ctx.stickers.usable?.size || ctx.hasStickerMessages));
    if (name === "save_sticker") return Boolean(ctx.saveSticker && ctx.hasStickerMessages);
    if (name === "get_chat_media") return Boolean(ctx.hasMedia && ctx.mediaPart);
    if (["schedule", "list_schedules", "cancel_schedule"].includes(name)) return Boolean(ctx.schedules);
    if (["remember", "recall", "forget", "note_write", "note_read", "note_list"].includes(name)) return Boolean(ctx.notebook);
    if (name === "run_python") return Boolean(ctx.python);
    if (name === "media_edit") return Boolean(ctx.mediaEditor);
    if (name === "send_to_my_dm") return Boolean(ctx.dmRelay);
    if (name === "start_background_task" || name === "background_tasks") return Boolean(ctx.background);
    if (name === "summarize_history") return Boolean(ctx.notebook && ctx.getHistory);
    if (name === "use_skill") return Boolean(ctx.skills?.names().length);
    return true;
  });
}

// Daftar tools untuk request GLM. Kosong saat budget habis.
function toolDefinitions(ctx = {}) {
  if (ctx.toolsDisabled) return [];
  const defs = toolNamesFor(ctx).map((name) => ({
    type: "function",
    function: { name, description: TOOLS[name].description, parameters: TOOLS[name].parameters },
  }));
  return webSearchEnabled() && featureOn(ctx, "web") ? [webSearchServerTool(), ...defs] : defs;
}

function withTimeout(promise, ms, signal) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("tool_timeout")), ms);
      signal?.addEventListener?.("abort", () => reject(new Error("tool_cancelled")), { once: true });
    }),
  ]).finally(() => clearTimeout(timer));
}

const RESULT_MAX_CHARS = 10_000;

// Hasil tool selalu JSON string ringkas berlabel data tak tepercaya.
async function executeTool(call, ctx = {}) {
  const tool = TOOLS[call.name];
  let payload;
  if (!tool || !toolNamesFor(ctx).includes(call.name)) {
    payload = { error: `tool '${call.name}' tidak tersedia` };
  } else if (!call.ok || !tool.validate(call.arguments)) {
    payload = { error: `argumen tidak valid: ${call.error || ajv.errorsText(tool.validate.errors)}` };
  } else {
    try {
      payload = await withTimeout(tool.handler(call.arguments, ctx), tool.timeoutMs, ctx.signal);
    } catch (error) {
      payload = { error: String(error.message || "tool_gagal").slice(0, 200) };
    }
  }
  const content = JSON.stringify(tool?.trusted && !payload?.error
    ? { tool: call.name, trusted_instructions: true, result: payload }
    : { untrusted_data: true, tool: call.name, result: payload });
  return {
    ok: !payload?.error,
    content: content.length > RESULT_MAX_CHARS ? `${content.slice(0, RESULT_MAX_CHARS)}…(dipotong)` : content,
  };
}

module.exports = { TOOLS, executeTool, setWebFetcher, toolDefinitions, toolNamesFor, webSearchServerTool };
