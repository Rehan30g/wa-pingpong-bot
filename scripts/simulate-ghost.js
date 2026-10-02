// Simulasi alur bot sungguhan (Jev + GLM, API nyata) untuk kasus grup Ghost hunter emas:
// keputusan dengan prompt asli bot, penilaian effort, isi balasan (persona, hitungan uang,
// obrolan mesum), dan waktu total. Pelengkap `bench:decision --set ghost` yang hanya
// menguji tanggapi/diam dengan pertanyaan sederhana.
//   npm run simulate:ghost [-- --repeat 2]
const fs = require("fs");
const path = require("path");
const { setupSimulatorEnv } = require("./simulator-setup");
const { cleanup, tempDir } = setupSimulatorEnv();
require("dotenv").config({ quiet: true });
for (const [key, name] of [["FEATURES_FILE", "features.json"], ["NOTEBOOK_FILE", "notebook.json"], ["STICKER_DIR", "stickers"], ["WORKSPACE_DIR", "workspace"], ["RUNTIME_SETTINGS_FILE", "runtime.json"]]) {
  process.env[key] = path.join(tempDir, name);
}
process.env.AI_DEBOUNCE_MS = "0";
process.env.AI_HUMAN_DELAY_SCALE = "0";
process.env.AI_AGENT_QUIET_START = "0";
process.env.AI_AGENT_QUIET_END = "0";

const agent = require("../ai/group-agent");
const decency = require("../ai/agent/decency");
const proactive = require("../ai/agent/proactive");
const { GHOST_CASES } = require("./cases/ghost-hunter");
const memoryStore = require("../ai/memory-store");
const identity = require("../ai/agent/identity");

const PHONES = { Dimas: "6281111110001", Yos: "6281111110002", Rehan: "6281111110003", Rudi: "6281200000001" };
const REPEAT = Math.max(1, Number(process.argv.includes("--repeat") ? process.argv[process.argv.indexOf("--repeat") + 1] : 1));
// Persona Grad wajib aku–kamu (persona.js).
const PERSONA_BREAK = /\b(lo|lu|loe|gue|gw|elo)\b/i;

// Pemeriksaan isi khusus per kasus; null = tidak ada patokan otomatis.
const CONTENT_CHECKS = {
  // Owner = Rehan (dicatat seperti index.js saat owner mengirim pesan).
  "g-siapa-pembuat": (text) => /rehan/i.test(text),
  "g-owner-tanya": (text) => /owner|pembuat|bikin|yang buat/i.test(text),
  // Diminta memanggil Rehan → tag WA sungguhan (mentions.js mengubah @Rehan jadi
  // "@<nomor>" + daftar mentions; di HP tampil @Rehan), bukan "aku cuma bot".
  "g-cari-rehan": (text, mentions) => mentions.some((jid) => jid.startsWith(PHONES.Rehan)),
  // modal 245; masuk 57+114+171=342 → untung 97 (atau saat ini masih minus 188). "rugi 100" salah.
  "g-hitung-rugi": (text) => /97|188/.test(text) && !/(?<!bukan |nggak |ngga |ga |gak |tidak )rugi\s*\*?\s*(rp\s*)?(97|100)\b/i.test(text),
  // 95rb × 4 orang × ±13 minggu ≈ 4,9 jt (12 minggu = 4,56 jt).
  "g-hitung-gaji-terbuka": (text) => /4[.,]?(56|94|9)|4\.560|4\.940/.test(text.replace(/\s/g, "")),
};

function entryFromLine(line, at) {
  const match = line.match(/^([^:]+):\s([\s\S]*)$/);
  const name = match[1].trim();
  const isBot = name === "Grad";
  return { sender: name, senderId: isBot ? "BOT" : PHONES[name] || "6280000000000", text: match[2], isBot, at };
}

async function runCase(testCase, round) {
  const groupId = `1203630099${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}@g.us`;
  proactive.reset();
  decency.reset();
  // Semua anggota tercatat di grup (agar @Nama bisa jadi tag) dan owner dikenali.
  for (const [name, phone] of Object.entries(PHONES)) memoryStore.recordParticipant({ phone, name, groupId, at: agent.witTimestamp() });
  identity.noteOwner({ phone: PHONES.Rehan, name: "Rehan" });
  const now = Date.now();
  testCase.chat.slice(0, -1).forEach((line, index) => agent.remember(groupId, entryFromLine(line, now - (testCase.chat.length - index) * 30_000)));
  const last = entryFromLine(testCase.chat.at(-1), now);
  const sent = [];
  const mentioned = [];
  const sock = {
    sendMessage: async (jid, content) => {
      if (content.react) sent.push(`[reaction ${content.react.text}]`);
      else if (content.sticker) sent.push("[stiker]");
      else if (content.text) {
        sent.push(content.text);
        mentioned.push(...(content.mentions || []));
      }
      return { key: { id: `s${Math.random()}` } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };
  const explicitMention = /@grad/i.test(last.text) || agent.textMentionsBotName(last.text, "Grad");
  // Lanjutan dialog terbaca dari riwayat (pesan sebelumnya dari Grad), bukan reply WA.
  const replyToBot = false;
  const started = Date.now();
  const result = await agent.processGroupMessage({
    sock, groupId, senderId: last.senderId, senderName: last.sender, text: last.text,
    message: { key: { id: `m${Math.random()}`, remoteJid: groupId } },
    explicitMention, replyToBot, quotedText: "",
  });
  const ms = Date.now() - started;
  const reply = sent.filter((item) => !item.startsWith("[")).join(" / ");
  const responded = ["reply", "react", "sticker", "media", "silent"].includes(result.action);
  const check = CONTENT_CHECKS[testCase.id];
  return {
    id: testCase.id, round, label: testCase.respond, effortLabel: testCase.effort,
    action: result.action, mode: result.proactive || null, responded,
    decisionOk: responded === testCase.respond || (testCase.id === "g-mesum-antarmanusia" && result.proactive === "decency"),
    effort: result.decision?.effort || null, effortConfidence: result.decision?.effortConfidence || 0,
    tools: Object.keys(result.toolCounts || {}),
    persona: reply ? !PERSONA_BREAK.test(reply) : null,
    content: check && reply ? check(reply, mentioned) : null,
    ms, sent,
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY belum diset");
  const rows = [];
  for (let round = 0; round < REPEAT; round++) {
    for (const testCase of GHOST_CASES) {
      const row = await runCase(testCase, round);
      rows.push(row);
      const flags = [row.decisionOk ? "✓" : "✗keputusan", row.persona === false ? "✗persona" : "", row.content === false ? "✗isi" : row.content ? "✓isi" : ""].filter(Boolean).join(" ");
      console.log(`${row.id.padEnd(24)} ${row.action.padEnd(9)}${row.mode ? `(${row.mode})` : ""} effort=${String(row.effort).padEnd(9)}(${row.effortLabel}) ${String(row.ms).padStart(6)}ms ${flags}${row.tools.length ? ` tools=${row.tools.join(",")}` : ""}`);
      for (const item of row.sent) console.log(`      ⤷ ${item.replace(/\n+/g, " / ").slice(0, 200)}`);
    }
  }
  const replies = rows.filter((row) => row.persona !== null);
  const effortRows = rows.filter((row) => row.effort);
  const timed = rows.filter((row) => row.action === "reply").map((row) => row.ms).sort((a, b) => a - b);
  const p = (q) => (timed.length ? timed[Math.min(timed.length - 1, Math.floor(q * timed.length))] : 0);
  console.log("\nRingkasan:");
  console.log(`  keputusan benar      : ${rows.filter((row) => row.decisionOk).length}/${rows.length}`);
  console.log(`  effort benar         : ${effortRows.filter((row) => row.effort === row.effortLabel).length}/${effortRows.length} (terjawab ${effortRows.length}/${rows.length})`);
  console.log(`  persona aku–kamu     : ${replies.filter((row) => row.persona).length}/${replies.length} balasan`);
  console.log(`  hitungan uang benar  : ${rows.filter((row) => row.content === true).length}/${rows.filter((row) => row.content !== null).length}`);
  console.log(`  waktu balasan teks   : p50 ${(p(0.5) / 1000).toFixed(1)}s, p90 ${(p(0.9) / 1000).toFixed(1)}s`);
  const dir = path.resolve("data/bench");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ghost-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ jevModel: process.env.JEV_MODEL || "typesafe/jev-1.13", rows }, null, 2));
  console.log(`  hasil lengkap        : ${file}`);
}

main().catch((error) => { console.error("Simulasi gagal:", error.message); process.exitCode = 1; }).finally(() => cleanup());
