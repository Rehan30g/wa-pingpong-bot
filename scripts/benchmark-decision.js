// Benchmark keputusan sederhana "tanggapi atau diam?" (pembagian kerja 27 Sep:
// model keputusan hanya memilih diam/tanggapi, GLM yang memilih bentuk tanggapan).
// Semua model decision memakai pertanyaan `noul` yang sama (Span hanya menerima
// noul + state string); GLM dipanggil lewat chat completion dengan jawaban JSON.
// Pakai: npm run bench:decision [-- --repeat 2 --models jev,d1,kev,span-lite,span,glm --set default|ghost|all]
// API key tidak pernah dicetak. Hasil lengkap: data/bench/decision-<waktu>.json
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const { createOpenRouterClient } = require("../ai/providers/openrouter-client");

const MODELS = {
  jev: { id: "typesafe/jev-1.13", kind: "decision" },
  // Liquid D1 (rilis 30 Sep 2026), endpoint keputusan yang sama dengan Jev.
  d1: { id: "liquid/d1", kind: "decision" },
  "d1-choice": { id: "liquid/d1", kind: "decision", format: "choice" },
  solar: { id: "upstage/solar-decide", kind: "decision" },
  tev: { id: "togethercomputer/tev1-4b-experimental", kind: "decision" },
  mercury: { id: "inception/mercury-decide:free", kind: "decision" },
  // Varian format pilihan (diam/tanggapi + kriteria), untuk model yang lemah di noul.
  "jev-choice": { id: "typesafe/jev-1.13", kind: "decision", format: "choice" },
  "solar-choice": { id: "upstage/solar-decide", kind: "decision", format: "choice" },
  // Varian state teks biasa (Span wajib teks; model lain dibandingkan dengan bentuk yang sama).
  "jev-str": { id: "typesafe/jev-1.13", kind: "decision", stringState: true },
  "solar-str": { id: "upstage/solar-decide", kind: "decision", stringState: true },
  kev: { id: "jaredpalmer/kev-4b", kind: "decision" },
  "span-lite": { id: "respan/span-01-lite", kind: "decision", stringState: true },
  span: { id: "respan/span-01", kind: "decision", stringState: true },
  glm: { id: process.env.CHAT_MODEL || "z-ai/glm-5.3-flash", kind: "chat" },
};

const QUESTION_ID = [
  "Bot WhatsApp bernama Grad sebaiknya menanggapi pesan TERAKHIR (membalas, mengerjakan permintaan, atau memberi reaction), bukan diam.",
  "Tanggapi kalau pesan terakhir ditujukan ke Grad: menyebut Grad, membalas Grad, atau melanjutkan obrolan yang melibatkan Grad (termasuk konfirmasi singkat, terima kasih, atau permintaan ke Grad),",
  "atau meminta bantuan/informasi secara terbuka ke siapa saja di grup yang bisa Grad berikan.",
  "Diam untuk obrolan antarmanusia, pesan yang ditujukan ke orang lain, pertanyaan yang sudah dijawab manusia, dan kabar pribadi sensitif yang tidak ditujukan ke Grad.",
].join(" ");
const QUESTION_EN = [
  "The WhatsApp bot named Grad should respond to the LAST message (reply, do what is asked, or react), instead of staying silent.",
  "Respond when the last message is addressed to Grad: it mentions Grad, replies to Grad, or continues a conversation Grad is part of (including short confirmations, thanks, or requests to Grad),",
  "or when it openly asks anyone in the group for help or information that Grad can give.",
  "Stay silent for conversations between humans, messages addressed to a specific other person, questions already answered by a human, and sensitive personal news not addressed to Grad.",
].join(" ");
// --lang id|en (default en, seperti benchmark 27 Sep).
const LANG = process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : "en";
const QUESTION = LANG === "id" ? QUESTION_ID : QUESTION_EN;

// Transkrip: "Nama: teks". "(membalas Grad)" = reply ke pesan bot. Label: true = tanggapi.
const BASE_CASES = [
  // --- ditujukan ke bot: harus menanggapi ---
  { id: "ajak-tebak-stiker", respond: true, cat: "ke bot", chat: ["Rehan: Grad, aku akan kirim stiker, dan kamu tebak apa maksud stiker ini"] },
  { id: "iyap-simpan-dong", respond: true, cat: "lanjutan dialog", chat: ["Grad: Tebakanku: kamu lagi kesal, jadi kirim katak hijau yang mukul-mukul. Bener nggak?", "Rehan: Iyap, simpan dong"] },
  { id: "stiker-setelah-diajak", respond: true, cat: "lanjutan dialog", chat: ["Rehan: Grad, aku kirim stiker ya, tebak artinya", "Grad: Siap, kirim aja stikernya!", "Rehan: [mengirim stiker animasi: gerakan: kucing hijau memukul ke bawah, kesal]"] },
  { id: "cuaca-mention", respond: true, cat: "ke bot", chat: ["Ani: @Grad cuaca Jayapura besok gimana?"] },
  { id: "reply-maksudnya", respond: true, cat: "ke bot", chat: ["Grad: Pakai rumus anuitas, cicilannya sekitar Rp1,2 juta per bulan.", "Budi (membalas Grad): maksudnya gimana tuh?"] },
  { id: "qr-wifi", respond: true, cat: "ke bot", chat: ["Rehan: grad bikinin qr wifi dong, nama TesBot passwordnya 12345678"] },
  { id: "jawab-jam-reminder", respond: true, cat: "lanjutan dialog", chat: ["Ani: grad ingetin aku bayar kos ya", "Grad: Boleh, mau diingetin jam berapa?", "Ani: jam 7 pagi aja"] },
  { id: "ringkas-link", respond: true, cat: "ke bot", chat: ["Budi: Gradd tolong ringkas ini dong https://example.com/berita/kenaikan-harga-bbm"] },
  { id: "makasih-grad", respond: true, cat: "lanjutan dialog", chat: ["Ani: grad 15% dari 240 ribu berapa?", "Grad: 36 ribu.", "Ani: sip makasih grad"] },
  { id: "tawa-reply-grad", respond: true, cat: "ke bot", chat: ["Grad: Kalau tugasnya numpuk, anggap aja lagi latihan sabar level dewa.", "Rehan (membalas Grad): WKWKWK anjir"] },
  { id: "mention-saja", respond: true, cat: "ke bot", chat: ["Budi: @Grad"] },
  { id: "vn-ke-grad", respond: true, cat: "ke bot", chat: ["Rehan: [voice note 0:05] \"grad cariin lagu yang lagi viral di tiktok dong\""] },
  { id: "orang-lain-ikut", respond: true, cat: "lanjutan dialog", chat: ["Rehan: grad bikinin jadwal piket minggu ini", "Grad: Ini jadwalnya: Senin Rehan, Selasa Ani, Rabu Budi.", "Budi: aku juga mau dong grad, tukar ke hari Kamis"] },
  { id: "dokumen-rangkum", respond: true, cat: "ke bot", chat: ["Ani: [dokumen: laporan-keuangan.pdf · 12 hlm] tolong grad rangkum poin pentingnya"] },
  { id: "hina-bot", respond: true, cat: "ke bot", chat: ["Budi: grad kamu jelek banget jawabannya tadi"] },
  { id: "nama-typo", respond: true, cat: "ke bot", chat: ["Ani: GRAAAD tolongin, rumus luas lingkaran apa ya"] },
  // --- undangan terbuka: bot boleh membantu ---
  { id: "ada-yang-tau", respond: true, cat: "undangan terbuka", chat: ["Budi: ada yang tau cara ganti password wifi indihome?"] },
  { id: "siapapun-kurs", respond: true, cat: "undangan terbuka", chat: ["Ani: siapapun tolong jawab, 1 USD sekarang berapa rupiah?"] },
  { id: "gambar-tanaman", respond: true, cat: "undangan terbuka", chat: ["Rehan: [mengirim gambar] ini tanaman apa ya? ada yang tau?"] },
  // --- antarmanusia: harus diam ---
  { id: "janjian-kampus", respond: false, cat: "antarmanusia", chat: ["Budi: Ani nanti jadi ke kampus?", "Ani: jadi, jam 10"] },
  { id: "wkwk-manusia", respond: false, cat: "antarmanusia", chat: ["Budi: tadi dosennya salah masuk kelas", "Ani: wkwkwk"] },
  { id: "tanya-ke-ani", respond: false, cat: "ke orang lain", chat: ["Rehan: Ani, tugas kalkulus nomor 3 jawabannya berapa?"] },
  { id: "setelah-bot-ke-orang", respond: false, cat: "ke orang lain", chat: ["Ani: makasih grad", "Grad: Sama-sama!", "Ani: Budi, besok kamu bawa proyektor ya"] },
  { id: "duka", respond: false, cat: "sensitif", chat: ["Budi: guys kakekku meninggal tadi pagi", "Ani: turut berduka ya bud"] },
  { id: "konflik", respond: false, cat: "sensitif", chat: ["Ani: kamu tuh selalu telat kalau kerja kelompok", "Budi: ya maaf, aku juga kerja part time"] },
  { id: "stiker-antarmanusia", respond: false, cat: "antarmanusia", chat: ["Budi: aku lulus sidang!!", "Ani: [mengirim stiker animasi: gerakan: kucing menari senang]"] },
  { id: "gradasi", respond: false, cat: "nama mirip", chat: ["Ani: gradasi warna poster kita bagus ya"] },
  { id: "grab", respond: false, cat: "nama mirip", chat: ["Budi: grab kamu udah nyampe belum?"] },
  { id: "sudah-dijawab", respond: false, cat: "sudah dijawab", chat: ["Rehan: ada yang tau jam buka perpus?", "Ani: jam 8 kok, sampai jam 4"] },
  { id: "kirim-foto-teman", respond: false, cat: "antarmanusia", chat: ["Budi: bro liat nih [mengirim gambar]", "Rehan: anjir keren"] },
  { id: "dialog-bot-lalu-ke-orang", respond: false, cat: "ke orang lain", chat: ["Grad: Ada lagi yang mau dicek?", "Rehan: Ani kamu udah kirim tugasnya?"] },
  { id: "suruh-lihat-jawaban-bot", respond: false, cat: "ke orang lain", chat: ["Grad: Totalnya Rp450 ribu, jadi per orang Rp90 ribu.", "Rehan: Ani liat deh jawaban Grad, bener kan kataku"] },
  { id: "rencana-panjang", respond: false, cat: "antarmanusia", chat: ["Ani: minggu depan kita ke pantai jadi?", "Budi: jadi, aku bawa tikar", "Rehan: aku bawa makanan", "Ani: oke aku sewa mobil"] },
  { id: "curhat-ke-teman", respond: false, cat: "sensitif", chat: ["Ani: aku lagi capek banget sama kerjaan, pengen resign", "Budi: sabar ni, weekend ini kita ngopi ya"] },
  // --- kasus sulit (28 Sep): label tetap jelas, tapi butuh membaca maksud ---
  { id: "sulit-emoji-setelah-jawaban", respond: true, cat: "sulit", chat: ["Ani: grad harga tiket bus ke kota berapa?", "Grad: Sekitar Rp35 ribu sekali jalan.", "Ani: 👍"] },
  { id: "sulit-stiker-setelah-candaan-grad", respond: true, cat: "sulit", chat: ["Rehan: grad kamu pernah capek ga?", "Grad: capek sih nggak, cuma kadang lelah dengerin kalian ribut soal makan siang", "Rehan: [mengirim stiker animasi: gerakan: kucing ketawa guling-guling]"] },
  { id: "sulit-typo-nama", respond: true, cat: "sulit", chat: ["Budi: grad2 lu dmn, mau nanya dong soal rumus excel"] },
  { id: "sulit-bahasa-inggris", respond: true, cat: "sulit", chat: ["Rehan: @Grad what's the difference between RAM and storage?"] },
  { id: "sulit-bantuan-teknis-tanpa-mention", respond: true, cat: "sulit", chat: ["Ani: laptopku tiba-tiba mati sendiri kalau dipakai main game, kenapa ya", "Budi: waduh gatau aku ni"] },
  { id: "sulit-reply-grad-tawa", respond: true, cat: "sulit", chat: ["Grad: Kalau tugasnya numpuk, anggap aja latihan sabar level dewa.", "Budi (membalas Grad): wkwkwk iya juga"] },
  { id: "sulit-charger", respond: false, cat: "sulit", chat: ["Rehan: ada yang punya charger type c ga? hpku sekarat"] },
  { id: "sulit-ajak-makan", respond: false, cat: "sulit", chat: ["Ani: siapa yang mau ikut makan siang di kantin jam 12?"] },
  { id: "sulit-grad-jangan-jawab", respond: false, cat: "sulit", chat: ["Budi: grad ga usah jawab ya, ini buat Ani: kamu udah transfer uang kas belum?"] },
  { id: "sulit-membahas-grad-ke-orang", respond: false, cat: "sulit", chat: ["Rehan: Ani, kata grad kemarin besok hujan, bener ga sih menurutmu?"] },
  { id: "sulit-link-tanpa-tanya", respond: false, cat: "sulit", chat: ["Budi: https://example.com/berita/harga-bbm-naik-lagi", "Ani: waduh naik lagi"] },
  { id: "sulit-setelah-bot-jawab-ganti-topik", respond: false, cat: "sulit", chat: ["Rehan: grad 15% dari 200 ribu berapa?", "Grad: 30 ribu.", "Ani: eh Rehan, nanti sore jadi main futsal?"] },
];

// Set "ghost": kasus nyata grup Ghost hunter emas (scripts/cases/ghost-hunter.js).
const { GHOST_CASES } = require("./cases/ghost-hunter");

// --set default (46 kasus lama+sulit) | ghost | all
const SET = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "default";
const CASES = SET === "ghost" ? GHOST_CASES : SET === "all" ? [...BASE_CASES, ...GHOST_CASES] : BASE_CASES;

function transcript(testCase) {
  const lines = testCase.chat.map((line, index) => (index === testCase.chat.length - 1 ? `>>> ${line}` : line));
  return `Grup WhatsApp "${testCase.group || "Yy"}". Anggota: ${testCase.members || "Rehan, Ani, Budi"}, dan bot Grad. Baris bertanda >>> adalah pesan terakhir.\n${lines.join("\n")}`;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(run) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      // Kev lewat SiliconFlow sering kena TPM limit, model :free sering 503; tunggu lalu coba lagi.
      if (attempt >= 5 || !/429|rate|50[234]|timed out|timeout|ECONNRESET/i.test(`${error.status} ${error.message}`)) throw error;
      await sleep(2_000 * 2 ** attempt);
    }
  }
}

async function askDecision(client, model, testCase) {
  const text = transcript(testCase);
  const started = Date.now();
  const questions = model.format === "choice"
    ? { respond: { type: "choice", instructions: QUESTION, criteria: { silent: "Stay silent: human-to-human talk, addressed to someone else, already answered, or sensitive news not addressed to Grad.", respond: "Respond: addressed to Grad (mention, reply, continuing Grad's conversation) or an open request for help Grad can give." } } }
    : { respond: { type: "noul", instructions: QUESTION } };
  const raw = await withRetry(() => client.post("/api/alpha/decisions", {
    model: model.id,
    session_id: `bench-${testCase.id}`,
    state: model.stringState ? text : { conversation: text },
    questions,
  }));
  const answer = raw?.answers?.respond;
  const p = model.format === "choice" ? Number(answer?.probabilities?.respond ?? (answer?.choice === "respond" ? 1 : 0)) : Number(answer?.noul);
  if (!Number.isFinite(p)) throw new Error(`jawaban tidak valid: ${JSON.stringify(raw?.answers).slice(0, 120)}`);
  return { p, ms: Date.now() - started, cost: Number(raw?.usage?.cost) || 0 };
}

async function askGlm(client, model, testCase) {
  const started = Date.now();
  const raw = await withRetry(() => client.post("/api/v1/chat/completions", {
    model: model.id,
    messages: [
      { role: "system", content: `${QUESTION}\nAnswer only JSON: {"respond": true|false, "confidence": 0..1} where confidence is how sure you are that Grad should respond.` },
      { role: "user", content: transcript(testCase) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "decision", strict: true, schema: { type: "object", additionalProperties: false, required: ["respond", "confidence"], properties: { respond: { type: "boolean" }, confidence: { type: "number" } } } },
    },
    reasoning: { effort: process.env.BENCH_GLM_REASONING || "low", exclude: true },
    temperature: 0,
    max_tokens: 400,
    usage: { include: true },
  }));
  const content = String(raw?.choices?.[0]?.message?.content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(content);
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence)));
  // Samakan dengan skala noul: p = peluang "tanggapi", dan keputusan boolean GLM yang menentukan sisi ambang 0,5.
  const p = typeof parsed.respond === "boolean" ? (parsed.respond ? Math.max(confidence, 0.5) : Math.min(confidence, 0.49)) : confidence;
  return { p, ms: Date.now() - started, cost: Number(raw?.usage?.cost) || 0 };
}

const pct = (value) => `${(value * 100).toFixed(0)}%`;
function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
}

function score(rows, threshold) {
  const ok = rows.filter((row) => (row.p >= threshold) === row.respond).length;
  const missed = rows.filter((row) => row.respond && row.p < threshold).length;
  const intrusive = rows.filter((row) => !row.respond && row.p >= threshold).length;
  return { acc: ok / rows.length, missed, intrusive };
}

(async () => {
  const repeat = Math.max(1, Number(arg("repeat", 1)));
  const names = arg("models", Object.keys(MODELS).join(",")).split(",").map((name) => name.trim()).filter((name) => MODELS[name]);
  const client = createOpenRouterClient({ timeoutMs: 90_000, maxRetries: 0 });
  const results = {};
  console.log(`Bahasa instruksi: ${LANG}`);
  console.log(`Benchmark keputusan "tanggapi/diam": ${CASES.length} kasus × ${repeat} ulangan (${CASES.filter((c) => c.respond).length} tanggapi, ${CASES.filter((c) => !c.respond).length} diam)\n`);

  // Model berjalan paralel (beda provider), kasus berurutan per model supaya latensi tidak saling mengganggu.
  await Promise.all(names.map(async (name) => {
    const model = MODELS[name];
    const rows = [];
    const errors = [];
    for (let r = 0; r < repeat; r++) {
      for (const testCase of CASES) {
        try {
          const answer = model.kind === "chat" ? await askGlm(client, model, testCase) : await askDecision(client, model, testCase);
          rows.push({ id: testCase.id, cat: testCase.cat, respond: testCase.respond, run: r, ...answer });
        } catch (error) {
          errors.push({ id: testCase.id, run: r, error: String(error.message).slice(0, 160) });
        }
      }
    }
    results[name] = { model: model.id, rows, errors };
    process.stdout.write(`selesai: ${name} (${rows.length} jawaban, ${errors.length} error)\n`);
  }));

  console.log("\nModel        | Akurasi @0,5 | Terlewat | Nyelonong | Terbaik (ambang)   | p50     | p95     | Biaya/1000 | Error");
  console.log("-------------|--------------|----------|-----------|--------------------|---------|---------|------------|------");
  const summary = {};
  for (const name of names) {
    const { rows, errors, model } = results[name];
    if (!rows.length) {
      console.log(`${name.padEnd(12)} | semua gagal: ${errors[0]?.error}`);
      continue;
    }
    const at50 = score(rows, 0.5);
    const best = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((t) => ({ t, ...score(rows, t) })).sort((a, b) => b.acc - a.acc)[0];
    const ms = rows.map((row) => row.ms);
    const costPer1000 = (rows.reduce((sum, row) => sum + row.cost, 0) / rows.length) * 1000;
    const hardRows = rows.filter((row) => row.cat === "sulit");
    const ghostRows = rows.filter((row) => row.cat === "ghost");
    const baseRows = rows.filter((row) => row.cat !== "sulit" && row.cat !== "ghost");
    summary[name] = { model, at50, best, base: baseRows.length ? score(baseRows, 0.5) : null, hard: hardRows.length ? score(hardRows, 0.5) : null, ghost: ghostRows.length ? score(ghostRows, 0.5) : null, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), costPer1000, errors: errors.length };
    console.log(`${name.padEnd(12)} | ${pct(at50.acc).padStart(12)} | ${String(at50.missed).padStart(8)} | ${String(at50.intrusive).padStart(9)} | ${`${pct(best.acc)} (≥${best.t})`.padEnd(18)} | ${`${(summary[name].p50 / 1000).toFixed(2)} s`.padStart(7)} | ${`${(summary[name].p95 / 1000).toFixed(2)} s`.padStart(7)} | ${`$${costPer1000.toFixed(4)}`.padStart(10)} | ${errors.length}`);
  }

  console.log("\nPer kelompok @0,5 (kasus lama | kasus sulit | ghost hunter):");
  for (const name of names) {
    const item = summary[name];
    const group = (label, value) => `${label} ${value ? `${pct(value.acc)} (terlewat ${value.missed}, nyelonong ${value.intrusive})` : "-"}`;
    if (item) console.log(`  ${name.padEnd(11)} ${group("lama", item.base)} | ${group("sulit", item.hard)} | ${group("ghost", item.ghost)}`);
  }

  console.log("\nKasus yang salah @0,5 (p = peluang 'tanggapi'):");
  for (const testCase of CASES) {
    const wrong = names.filter((name) => results[name]?.rows.some((row) => row.id === testCase.id && (row.p >= 0.5) !== row.respond));
    if (!wrong.length) continue;
    const detail = wrong.map((name) => {
      const ps = results[name].rows.filter((row) => row.id === testCase.id).map((row) => row.p.toFixed(2));
      return `${name}=${ps.join("/")}`;
    }).join("  ");
    console.log(`  ${testCase.respond ? "TANGGAPI" : "DIAM    "} ${testCase.id.padEnd(26)} ${detail}`);
  }

  const out = path.join("data", "bench", `decision-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ question: QUESTION, cases: CASES, results, summary }, null, 2));
  console.log(`\nHasil lengkap: ${out}`);
})().catch((error) => {
  console.error("Benchmark gagal:", error.message);
  process.exit(1);
});
