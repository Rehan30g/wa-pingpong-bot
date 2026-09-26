// Kontrol owner atas koleksi stiker Grad (Plan v2 §4a):
// /stiker · /stiker lihat <id> · /stiker buang <id> [alasan] · /stiker kurasi · /stiker review
const { getStickerCollector } = require("./collector");
const { getStickerLibrary } = require("./library");
const curator = require("./curator");

const KIND_LABEL = { keep: "simpan", skip: "skip", remove: "buang", revise: "revisi" };
const SOURCE_LABEL = { curation: "kurasi", review: "review", owner: "owner", rule: "aturan" };

function agoText(at, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "barusan";
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

const decisionLine = (d) => `• ${d.id} ${KIND_LABEL[d.kind] || d.kind}${d.label ? ` "${d.label}"` : ""} (${SOURCE_LABEL[d.source] || d.source}, ${agoText(d.at)})${d.reason ? `: ${d.reason}` : ""}`;

async function overviewText() {
  const library = getStickerLibrary();
  const stats = await getStickerCollector().stats({ limit: 5 });
  const favorites = await library.favorites(10);
  const decisions = await library.recentDecisions(5);
  const lastCuration = Number(await library.getMeta("last_curation_at")) || null;
  const lines = [
    "🗂️ *KOLEKSI STIKER GRAD*",
    `Koleksi: ${stats.collection} · kandidat menunggu: ${stats.candidates} · di-skip: ${stats.skipped}`,
    `Pemakaian manusia: ${stats.uses} total, ${stats.usesLast24h} dalam 24 jam`,
    `Kurasi terakhir: ${lastCuration ? agoText(lastCuration) : "belum pernah"}`,
  ];
  if (favorites.length) {
    lines.push("", "*Favorit Grad:*");
    for (const s of favorites) lines.push(`• ${s.id} "${s.label}" [${s.moods.join(", ")}] · dipakai ${s.botUseCount}× · ${s.plannedFrequency}${s.scope === "local" ? " · lokal" : ""}`);
  }
  if (stats.top.length) {
    lines.push("", "*Kandidat terpopuler:*");
    for (const item of stats.top) lines.push(`• ${item.sha.slice(0, 8)}${item.animated ? " (animasi)" : ""} · ${item.useCount}× · ${item.chats} chat · ${item.senders} orang`);
  }
  if (decisions.length) {
    lines.push("", "*Keputusan terakhir:*");
    for (const d of decisions) lines.push(decisionLine(d));
  }
  lines.push("", "Perintah: /stiker lihat <id>, /stiker buang <id> [alasan], /stiker kurasi, /stiker review");
  return lines.join("\n");
}

function curationSummaryText(summary) {
  if (!summary.considered) return "Tidak ada kandidat baru yang perlu dikurasi.";
  const lines = [`✅ Kurasi selesai: ${summary.considered} kandidat dinilai (biaya $${summary.cost.toFixed(4)}).`];
  if (summary.kept.length) {
    lines.push("", "*Disimpan:*");
    for (const k of summary.kept) lines.push(`• ${k.id} "${k.label}"${k.scope === "local" ? " (lokal)" : ""}: ${k.reason}`);
  }
  if (summary.skipped.length) {
    lines.push("", "*Di-skip:*");
    for (const s of summary.skipped) lines.push(`• ${s.id}${s.label ? ` "${s.label}"` : ""}: ${s.reason}`);
  }
  if (summary.removed.length) {
    lines.push("", "*Dibuang untuk memberi tempat:*");
    for (const r of summary.removed) lines.push(`• ${r.id} "${r.label}": ${r.reason}`);
  }
  if (summary.errors) lines.push("", `⚠️ ${summary.errors} batch gagal, kandidatnya dicoba lagi nanti.`);
  return lines.join("\n");
}

function reviewSummaryText(summary) {
  const lines = [`🔎 Review koleksi: ${summary.reviewed} stiker ditinjau.`];
  if (!summary.removed.length && !summary.revised.length) lines.push("Tidak ada yang dibuang atau direvisi.");
  for (const r of summary.removed) lines.push(`• buang ${r.id} "${r.label}": ${r.reason}`);
  for (const r of summary.revised) lines.push(`• revisi ${r.id} → "${r.label}": ${r.reason}`);
  return lines.join("\n");
}

/**
 * @returns {Promise<boolean>} true bila command ditangani.
 */
async function handleStickerCommand({ sock, jid, cmd, text = cmd, fromOwner }) {
  if (cmd !== "/stiker" && !cmd.startsWith("/stiker ")) return false;
  if (!fromOwner) {
    await sock.sendMessage(jid, { text: "❌ Hanya owner yang bisa mengatur koleksi stiker Grad." });
    return true;
  }
  const [, action = "", target = "", ...rest] = String(text).trim().split(/\s+/);
  const library = getStickerLibrary();
  const sub = action.toLowerCase();

  if (!sub) {
    await sock.sendMessage(jid, { text: await overviewText() });
    return true;
  }

  if (sub === "lihat" || sub === "buang") {
    const sticker = await library.findSticker(target);
    if (!sticker || sticker.ambiguous) {
      await sock.sendMessage(jid, { text: sticker?.ambiguous ? "Id itu cocok dengan lebih dari satu stiker, tulis lebih panjang." : `Stiker "${target || "?"}" tidak ditemukan.` });
      return true;
    }
    if (sub === "buang") {
      if (sticker.status !== "kept") {
        await sock.sendMessage(jid, { text: `Stiker ${sticker.id} tidak ada di koleksi (status: ${sticker.status}).` });
        return true;
      }
      await library.remove(sticker.sha, { reason: rest.join(" ") || "dibuang manual oleh owner", source: "owner" });
      await sock.sendMessage(jid, { text: `🗑️ Stiker ${sticker.id} "${sticker.label}" dibuang dari koleksi.` });
      return true;
    }
    const decision = await library.lastDecision(sticker.sha);
    if (sticker.file) {
      try {
        await sock.sendMessage(jid, { sticker: library.readFile(sticker) });
      } catch {}
    }
    const lines = sticker.status === "kept"
      ? [
        `*${sticker.id}* "${sticker.label}"`,
        `Mood: ${sticker.moods.join(", ") || "-"} · ${sticker.plannedFrequency} · ${sticker.scope === "local" ? "lokal (hanya chat asal)" : "global"}`,
        `Kapan dipakai: ${sticker.whenToUse || "-"}`,
        `Dipakai Grad: ${sticker.botUseCount}×${sticker.lastBotUseAt ? `, terakhir ${agoText(sticker.lastBotUseAt)}` : ""}`,
        `Alasan disimpan: ${sticker.reason || "-"}`,
      ]
      : [`*${sticker.id}* (${sticker.status}, dipakai manusia ${sticker.useCount}×)`];
    if (decision && !(sticker.status === "kept" && decision.kind === "keep")) {
      lines.push(`Keputusan terakhir: ${KIND_LABEL[decision.kind] || decision.kind} (${SOURCE_LABEL[decision.source] || decision.source}, ${agoText(Number(decision.at))}): ${decision.reason || "-"}`);
    }
    await sock.sendMessage(jid, { text: lines.join("\n") });
    return true;
  }

  if (sub === "kurasi" || sub === "review") {
    await sock.sendMessage(jid, { text: sub === "kurasi" ? "⏳ Mengkurasi kandidat stiker..." : "⏳ Meninjau koleksi stiker..." });
    try {
      const summary = sub === "kurasi" ? await curator.runCuration() : await curator.runWeeklyReview();
      await sock.sendMessage(jid, { text: sub === "kurasi" ? curationSummaryText(summary) : reviewSummaryText(summary) });
    } catch (error) {
      console.error(`[STIKER] /stiker ${sub} gagal:`, error.message);
      await sock.sendMessage(jid, { text: `⚠️ ${sub === "kurasi" ? "Kurasi" : "Review"} gagal, coba lagi nanti.` });
    }
    return true;
  }

  await sock.sendMessage(jid, { text: "Perintah: /stiker, /stiker lihat <id>, /stiker buang <id> [alasan], /stiker kurasi, /stiker review" });
  return true;
}

module.exports = { handleStickerCommand, overviewText };
