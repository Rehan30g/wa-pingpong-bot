// Katalog tools agent loop (Plan v2 §4, M1). Kontrak: schema JSON untuk model,
// handler, timeout, dan hasil ringkas. Tujuan pengiriman tidak pernah datang
// dari argumen model: tools di sini hanya membaca, bukan mengirim.
const path = require("node:path");
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

TOOLS.watch_video = {
  description: "Tonton video di riwayat chat (gambar + suara) lewat model video, lalu dapat jawaban teks: transkrip ucapan/lirik, apa yang terjadi, tulisan di layar, dsb. entry_id = nomor # pesan video, atau pesan yang me-reply video. question = pertanyaan spesifikmu (mis. 'transkrip semua ucapan dan lirik', 'apa yang terjadi di video ini'). Gambar video yang kamu lihat hanya satu frame, jadi untuk isi video selalu pakai ini.",
  parameters: {
    type: "object",
    properties: {
      entry_id: { type: "integer" },
      question: { type: "string" },
      context: { type: "string", description: "konteks singkat yang membantu (opsional)" },
    },
    required: ["entry_id", "question"],
    additionalProperties: false,
  },
  timeoutMs: 180_000,
  async handler(args, ctx) {
    if (!ctx.watchVideo) return { error: "menonton video tidak tersedia di chat ini" };
    try {
      const seen = await ctx.watchVideo(args);
      if (seen.error) return seen;
      ctx.addCost?.(seen.cost || 0);
      return { entry_id: args.entry_id, answer: seen.answer, truncated: seen.truncated || false, note: "Laporan model video. Sampaikan dengan gayamu; transkrip panjang boleh diringkas kecuali diminta lengkap." };
    } catch (error) {
      return { error: `video tidak bisa ditonton: ${String(error.message).slice(0, 160)}` };
    }
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

// Reaction ke pesan yang sedang dibalas. Sejak 27 Sep GLM (bukan Jev) yang memilih
// reaction vs teks vs stiker untuk pesan yang ditujukan ke bot.
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "👏"];
TOOLS.react = {
  description: "Beri reaction emoji ke pesan terbaru (yang sedang kamu tanggapi). Pakai kalau pesannya cukup diakui tanpa balasan (oke, sip, makasih, candaan singkat): lalu jawaban akhirmu KOSONG. Kalau mau ditambah balasan teks, tulis teksnya di pesan yang SAMA dengan panggilan react (setelah react tidak ada langkah lagi). Jangan pakai reaction untuk pesan yang berisi permintaan/pertanyaan tanpa mengerjakannya.",
  parameters: {
    type: "object",
    properties: { emoji: { type: "string", enum: REACTION_EMOJIS } },
    required: ["emoji"],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  async handler({ emoji }, ctx) {
    if (!ctx.reaction) return { error: "reaction tidak tersedia di sini" };
    ctx.reaction.emoji = emoji;
    return { ok: true, emoji, note: "reaction dikirim ke pesan terbaru; kalau tidak ada yang perlu dikatakan, jawaban akhirmu kosong" };
  },
};

// Lapisan kedua setelah Jev (owner 2 Okt): Jev sudah memutuskan menanggapi, tapi
// GLM yang membaca isinya boleh menolak menjawab. Loop langsung berhenti dan
// tidak ada apa pun yang terkirim (teks, stiker, reaction, maupun file).
const SILENCE_REASONS = ["tidak_senonoh", "pelecehan", "provokasi", "bukan_untukku", "lainnya"];
TOOLS.stay_silent = {
  description: "Pilih diam: tidak mengirim apa pun ke chat (teks, stiker, maupun reaction). Pakai HANYA kalau pesan yang kamu tanggapi memang tidak pantas dijawab: ajakan/obrolan seksual yang terus didesak setelah kamu tegur, minta konten porno, pelecehan, pancingan supaya kamu ikut mesum atau menghina orang, atau kalau ternyata pesannya bukan untukmu dan menjawab justru mengganggu. JANGAN dipakai untuk pertanyaan atau permintaan biasa.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", enum: SILENCE_REASONS } },
    required: ["reason"],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  async handler({ reason }, ctx) {
    ctx.silence = { reason };
    return { ok: true, note: "kamu memilih diam; tidak ada yang dikirim" };
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
    // Label wajib berasal dari gambar yang benar-benar dilihat, bukan tebakan.
    if (ctx.seenMedia && !ctx.seenMedia.has(args.entry_id)) {
      return { error: `kamu belum melihat stiker #${args.entry_id}. Panggil get_chat_media(${args.entry_id}) dulu, tunggu gambarnya, baru simpan dengan label sesuai yang terlihat` };
    }
    return ctx.saveSticker(args);
  },
};

TOOLS.remove_sticker = {
  description: "Buang stiker dari koleksimu atas permintaan pengguna ('hapus stiker itu', 'buang semua koleksimu'). sticker_ids = id dari daftar 'Koleksi stiker' (atau yang baru disimpan); all=true untuk semua koleksi yang terlihat di chat ini, termasuk yang sedang tidak ada di daftar karena baru dipakai. Hanya owner, admin grup, atau anggota dengan akses veto yang boleh; kalau ditolak, sampaikan apa adanya.",
  parameters: {
    type: "object",
    properties: {
      sticker_ids: { type: "array", items: { type: "string" }, maxItems: 200 },
      all: { type: "boolean" },
      reason: { type: "string", description: "alasan singkat dari peminta, boleh kosong" },
    },
    additionalProperties: false,
  },
  timeoutMs: 20_000,
  async handler(args, ctx) {
    if (!ctx.removeStickers) return { error: "membuang stiker tidak tersedia di chat ini" };
    if (!args.all && !args.sticker_ids?.length) return { error: "isi sticker_ids atau all=true" };
    return ctx.removeStickers(args);
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
  description: "Jalankan Python 3 di sandbox (numpy, pandas, matplotlib, pillow, sympy, qrcode, fpdf2, python-docx, python-pptx, openpyxl, pypdf). Dokumen .pdf/.docx/.pptx/.xlsx/.csv/.txt/.md/.json/.zip yang disimpan ke out/ dikirim ke chat sebagai file dokumen (maks 3 per run); format lain TIDAK dikirim. Zip berpassword: `import gradzip; gradzip.make_zip('out/x.zip', [file…], password='…')` (zipfile bawaan tidak bisa). Pakai untuk hitungan presisi, olah data, grafik/gambar, QR, atau memanggil API web: `import net; r = net.get(url, params={...}); r.json()` (juga net.post(url, json=...)). Simpan gambar ke folder out/ (mis. plt.savefig('out/grafik.png'), qrcode.make(teks).save('out/qr.png')) — semua gambar di out/ otomatis dikirim ke chat tepat DI BAWAH jawaban teksmu (jadi rujuk sebagai 'di bawah', dan jangan tulis ulang isinya). File lain di folder kerja tetap tersimpan untuk chat ini. print() hasil yang kamu butuhkan; ekspresi terakhir juga dikembalikan.",
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
    const produced = [...(run.images || []).map((image) => ({ ...image, kind: "image" })), ...(run.documents || []).map((doc) => ({ ...doc, kind: "document" }))];
    if (produced.length && ctx.outbox) {
      // File yang sama ditimpa run berikutnya: kirim sekali saja (versi terbaru).
      const paths = new Set(produced.map((item) => item.path));
      ctx.outbox.media = ctx.outbox.media.filter((item) => !paths.has(item.path)).concat(produced);
    }
    return {
      ok: run.ok,
      result: run.result ?? null,
      stdout: String(run.stdout || "").slice(0, 4_000),
      stderr: String(run.stderr || "").slice(0, 1_000),
      error: run.error || null,
      images_to_send: (run.images || []).map((image) => image.name),
      documents_to_send: (run.documents || []).map((doc) => doc.name),
      ...(run.notSent?.length ? { not_sent: run.notSent, not_sent_note: "file ini TIDAK terkirim; jangan bilang sudah dikirim. Simpan ulang dengan format yang didukung, atau tulis isinya langsung di jawaban kalau pendek." } : {}),
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
  description: "Kirim ke chat pribadi (DM) si peminta sendiri, hanya kalau dia memintanya (mis. 'kirim ke DM aku aja', 'japri aku hasilnya', 'yang kuning kirim ke DM gw'). text = isi pesan DM (boleh kosong). files = nama file hasil tugas ini (mis. 'qr_kuning.png') yang dipindah ke DM; file lain tetap dikirim ke grup. Buat filenya dulu (run_python/media_edit) sebelum memanggil ini. include_results = true memindahkan SEMUA hasil ke DM. Tidak bisa ke orang lain atau grup lain.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      files: { type: "array", items: { type: "string" }, maxItems: 10 },
      include_results: { type: "boolean" },
    },
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler({ text = "", files = [], include_results: includeResults = false }, ctx) {
    if (!ctx.dmRelay) return { error: "DM ke peminta tidak tersedia di sini" };
    const body = String(text || "").trim().slice(0, 3_000);
    if (!body && !includeResults && !files.length) return { error: "tidak ada yang dikirim" };
    // Kasus nyata 27 Sep: "ungu di grup, kuning ke DM" → semua hasil pindah ke DM
    // dan Grad mengklaim yang kuning terkirim. Pembagian kini per file dan dilaporkan balik.
    const produced = (ctx.outbox?.media || []).map((item) => item.name);
    const wanted = files.map((file) => path.basename(String(file)));
    const missing = wanted.filter((name) => !produced.includes(name));
    if (missing.length) return { error: `file belum ada di hasil tugas ini: ${missing.join(", ")}. Hasil yang ada: ${produced.join(", ") || "(belum ada)"}. Buat dulu filenya lalu panggil lagi.` };
    if (body) ctx.dmRelay.texts.push(body);
    for (const name of wanted) ctx.dmRelay.moveFiles.add(name);
    if (includeResults) ctx.dmRelay.moveResults = true;
    const toDm = produced.filter((name) => ctx.dmRelay.moveResults || ctx.dmRelay.moveFiles.has(name));
    return {
      ok: true,
      dm_files: ctx.dmRelay.moveResults ? "semua hasil (termasuk yang dibuat sesudah ini)" : toDm,
      group_files: ctx.dmRelay.moveResults ? [] : produced.filter((name) => !toDm.includes(name)),
      note: "Dikirim setelah balasanmu. Di grup sebut pembagiannya persis sesuai dm_files/group_files; jangan mengaku mengirim file yang tidak ada di daftar itu.",
    };
  },
};

TOOLS.tell_group = {
  description: "(Hanya di chat pribadi) Titip pesan dari lawan chatmu ke grup yang dia ikuti, kalau dia memintanya ('bilang ke grup aku telat', 'tolong ingetin @Ani di grup bayar kas'). Pesan dikirim terang-terangan atas nama dia ('<nama> titip pesan: …'), jadi tulis isi pesannya saja dari sudut pandang titipan; jangan menyamar atau berpura-pura itu idemu. Tag orang dengan @Nama hanya kalau dia memang minta orang itu dipanggil/diingatkan; jangan menambah tag sendiri (tidak boleh @semua). Pesan yang men-tag, menagih, atau menegur orang akan jadi draf dulu: tunjukkan preview-nya, lalu setelah dia setuju panggil lagi dengan confirm: true (tanpa text). Tolak titipan yang menghina, menuduh, atau mempermalukan orang.",
  parameters: {
    type: "object",
    properties: {
      group: { type: "string", description: "nama grup (boleh sebagian); kosong kalau dia hanya ikut satu grup" },
      text: { type: "string" },
      confirm: { type: "boolean", description: "true = kirim draf yang sedang menunggu karena dia sudah setuju ('oke kirim')" },
      confirm_draft: { type: "string", description: "opsional: draft_id yang disetujui" },
    },
    additionalProperties: false,
  },
  timeoutMs: 2_000,
  async handler(args, ctx) {
    if (!ctx.groupRelay) return { error: "titip pesan ke grup hanya bisa dari chat pribadi" };
    return require("./group-relay").request(ctx.groupRelay, args);
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
    const motion = media.motion?.summary || null;
    ctx.attachments = [...(ctx.attachments || []), { entryId, label: `Media dari pesan #${entryId} (${entry.sender}: ${String(entry.text).slice(0, 80)})${motion ? ` · gerakan animasinya: ${motion}` : ""}`, part }];
    return { ok: true, entry_id: entryId, kind: media.kind || media.type, ...(motion ? { motion, motion_note: "gambar hanya satu frame; deskripsi gerakan berasal dari menonton animasinya dan lebih bisa dipercaya untuk makna stiker/GIF" } : {}), note: "media terlampir di pesan berikutnya" };
  },
};

TOOLS.read_document = {
  description: "Baca dokumen (PDF, Word .docx, PowerPoint .pptx, Excel .xlsx, CSV, TXT) dari pesan di riwayat (entry_id: pesan dokumen atau pesan yang me-reply dokumen) atau file di folder kerja (file, mis. 'out/laporan.pdf'). Tanpa pages/query: awal dokumen sampai batas. pages: '3', '2-5', '1,4' (halaman/slide/sheet). query: kata kunci untuk mencari bagian yang relevan di dokumen panjang. Halaman PDF hasil scan otomatis dibaca OCR. Hasilnya tersimpan, jadi membaca bagian lain dari dokumen yang sama itu murah.",
  parameters: {
    type: "object",
    properties: {
      entry_id: { type: "integer" },
      file: { type: "string" },
      pages: { type: "string" },
      query: { type: "string" },
    },
    additionalProperties: false,
  },
  timeoutMs: 240_000,
  async handler(args, ctx) {
    if (!ctx.documents) return { error: "baca dokumen tidak tersedia di chat ini" };
    if (!Number.isInteger(args.entry_id) && !args.file) return { error: "isi entry_id atau file" };
    return ctx.documents(args, ctx);
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
const TOOL_FEATURE = { web_fetch: "web", listen_audio: "audio", watch_video: "media", send_sticker: "stiker", save_sticker: "stiker", remove_sticker: "stiker", get_chat_media: "media", schedule: "reminder", list_schedules: "reminder", cancel_schedule: "reminder",
  run_python: "python",
  media_edit: "edit_media",
  send_to_my_dm: null,
  tell_group: null,
  start_background_task: "latar",
  background_tasks: "latar",
  use_skill: "skill",
  read_document: "dokumen",
  remember: "memori", recall: "memori", forget: "memori", note_write: "memori", note_read: "memori", note_list: "memori", summarize_history: "memori" };

function featureOn(ctx, feature) {
  return !ctx.features || ctx.features.has(feature);
}

function toolNamesFor(ctx = {}) {
  return Object.keys(TOOLS).filter((name) => {
    if (TOOL_FEATURE[name] && !featureOn(ctx, TOOL_FEATURE[name])) return false;
    if (name === "listen_audio") return Boolean(ctx.hasAudio);
    if (name === "react") return Boolean(ctx.reaction);
    // Tugas latar & jadwal harus selalu mengirim hasil; diam hanya untuk tanggapan langsung.
    if (name === "stay_silent") return ctx.canSilence !== false;
    if (name === "watch_video") return Boolean(ctx.watchVideo && ctx.hasVideo);
    // send_sticker juga ditawarkan bila ada stiker yang bisa disimpan lalu langsung dipakai.
    if (name === "send_sticker") return Boolean(ctx.stickers && (ctx.stickers.usable?.size || ctx.hasStickerMessages));
    if (name === "save_sticker") return Boolean(ctx.saveSticker && ctx.hasStickerMessages);
    if (name === "remove_sticker") return Boolean(ctx.removeStickers && (ctx.stickers?.visible || ctx.stickers?.usable)?.size);
    if (name === "get_chat_media") return Boolean(ctx.hasMedia && ctx.mediaPart);
    if (["schedule", "list_schedules", "cancel_schedule"].includes(name)) return Boolean(ctx.schedules);
    if (["remember", "recall", "forget", "note_write", "note_read", "note_list"].includes(name)) return Boolean(ctx.notebook);
    if (name === "run_python") return Boolean(ctx.python);
    if (name === "media_edit") return Boolean(ctx.mediaEditor);
    if (name === "send_to_my_dm") return Boolean(ctx.dmRelay);
    if (name === "tell_group") return Boolean(ctx.groupRelay?.groups?.length);
    if (name === "start_background_task" || name === "background_tasks") return Boolean(ctx.background);
    if (name === "summarize_history") return Boolean(ctx.notebook && ctx.getHistory);
    if (name === "use_skill") return Boolean(ctx.skills?.names().length);
    if (name === "read_document") return Boolean(ctx.documents);
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

module.exports = { REACTION_EMOJIS, SILENCE_REASONS, TOOLS, executeTool, setWebFetcher, toolDefinitions, toolNamesFor, webSearchServerTool };
