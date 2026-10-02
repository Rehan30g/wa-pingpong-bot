// Jev ikut menilai seberapa berat pesan yang akan dijawab (owner 2 Okt 2026), di
// panggilan keputusan yang sama (pertanyaan opsional, tanpa panggilan tambahan).
// Hasilnya memilih provider GLM untuk langkah PERTAMA loop:
//  - quick → tier "fast" (latensi terendah: obrolan, satu fakta);
//  - elaborate → tier "balanced" (jawaban panjang/tugas berlapis: throughput & harga).
// Setelah tool dipakai, loop selalu "balanced" apa pun jawaban Jev.

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function effortEnabled() {
  return String(process.env.AGENT_JEV_EFFORT || "true").trim().toLowerCase() !== "false";
}

const EFFORT_QUESTION = {
  type: "choice",
  optional: true,
  instructions: [
    "Kalau bot menanggapi pesan paling terakhir, seberapa berat pekerjaannya?",
    "Nilai dari isi permintaan, bukan dari panjang pesannya.",
  ].join(" "),
  criteria: {
    quick: "Balasan pendek: obrolan, candaan, sapaan, konfirmasi, reaction, atau satu fakta/jawaban singkat.",
    elaborate: "Pekerjaan berlapis atau jawaban panjang: riset/perbandingan, penjelasan bertahap, hitungan banyak angka, membuat file/dokumen/QR/grafik/jadwal, mengolah media atau dokumen, atau beberapa permintaan sekaligus.",
  },
};

function parseEffort(answer) {
  if (!answer || typeof answer.choice !== "string") return { effort: null, effortConfidence: 0 };
  const confidence = Number(answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0);
  return { effort: answer.choice, effortConfidence: Number.isFinite(confidence) ? confidence : 0 };
}

/** Tier provider untuk langkah pertama loop dari keputusan Jev (tanpa jawaban = fast). */
function firstStepTier(decision) {
  const threshold = Math.min(1, Math.max(0, envNumber("AGENT_EFFORT_CONFIDENCE", 0.6)));
  return decision?.effort === "elaborate" && decision.effortConfidence >= threshold ? "balanced" : "fast";
}

module.exports = { EFFORT_QUESTION, effortEnabled, firstStepTier, parseEffort };
