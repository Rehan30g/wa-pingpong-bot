// Command fitur per grup (Plan v2 M2b). Pengaturan lewat DM supaya senyap:
//   /grup                          daftar grup yang boleh kamu atur
//   /fitur <no>                    status fitur grup itu
//   /fitur <no> <fitur> on|off     ubah (admin WA grup itu atau owner)
//   /fitur global [<fitur> kunci|buka]   kunci global (owner)
// Di grup: /fitur hanya menampilkan status (read-only, siapa pun).
const features = require("./features");

const ON = new Set(["on", "nyala", "aktif", "hidup", "1"]);
const OFF = new Set(["off", "mati", "nonaktif", "0"]);

function statusLines(chatId) {
  return features.statusFor(chatId).map((item) => {
    const icon = item.locked ? "🔒" : item.enabled ? "✅" : "❌";
    const note = item.locked ? " (dikunci owner)" : "";
    return `${icon} *${item.name}* — ${item.label}${note}`;
  });
}

function usage() {
  return `Fitur: ${features.availableFeatures().join(", ")}.`;
}

/**
 * @param {object} deps
 * @param {Function} deps.listGroups async () => [{ id, subject, admin: boolean }] grup aktif bot, dengan status admin pengirim dicek langsung
 * @returns {Promise<boolean>} true bila command ditangani
 */
async function handleFeatureCommand({ sock, jid, isGroup, isAllowedGroup, cmd, fromOwner, senderPhone, listGroups, canReply = false }) {
  if (cmd !== "/grup" && cmd !== "/fitur" && !cmd.startsWith("/fitur ")) return false;
  const reply = (text) => sock.sendMessage(jid, { text });

  // Di grup: hanya status, read-only.
  if (isGroup) {
    if (!isAllowedGroup) return true;
    if (cmd !== "/fitur") {
      await reply("Pengaturan fitur dilakukan lewat chat pribadi ke aku oleh admin grup (/grup). Di sini cukup /fitur untuk melihat status.");
      return true;
    }
    await reply([`⚙️ Fitur Grad di grup ini:`, ...statusLines(jid), "", "Admin grup bisa mengubahnya lewat chat pribadi ke aku: /grup"].join("\n"));
    return true;
  }

  const args = cmd.split(/\s+/).slice(1);

  if (args[0] === "global") {
    if (!fromOwner) {
      await reply("❌ Kunci global hanya untuk owner.");
      return true;
    }
    const [, name, action] = args;
    if (!name) {
      const lines = features.availableFeatures().map((f) => `${features.isLocked(f) ? "🔒" : "🔓"} *${f}* — ${features.FEATURES[f].label}`);
      await reply(["🌐 Kunci global fitur (🔒 = mati di semua grup):", ...lines, "", "Ubah: /fitur global <fitur> kunci|buka"].join("\n"));
      return true;
    }
    if (!features.isFeature(name) || !["kunci", "buka"].includes(action)) {
      await reply(`Format: /fitur global <fitur> kunci|buka. ${usage()}`);
      return true;
    }
    const result = features.setGlobalLock(name, action === "kunci", { phone: senderPhone, role: "owner" });
    await reply(result.ok ? `🌐 Fitur *${name}* sekarang ${result.after ? "dikunci di semua grup" : "dibuka; tiap grup memakai setelannya sendiri"}.` : "Gagal mengubah kunci global.");
    return true;
  }

  const groups = (await listGroups()).filter((group) => fromOwner || group.admin);
  // Aturan DM: orang asing (bukan owner, bukan admin grup aktif, tidak di whitelist) tidak dibalas.
  if (!groups.length && !fromOwner && !canReply) return true;
  if (cmd === "/grup" || !args.length) {
    if (!groups.length) {
      await reply("Kamu belum jadi admin di grup mana pun tempat aku aktif.");
      return true;
    }
    const lines = groups.map((group, index) => {
      const status = features.statusFor(group.id);
      return `${index + 1}. ${group.subject} (${status.filter((s) => s.enabled).length}/${status.length} fitur aktif)`;
    });
    await reply(["🛠️ Grup yang bisa kamu atur:", ...lines, "", "Lihat: /fitur <no> · Ubah: /fitur <no> <fitur> on|off"].join("\n"));
    return true;
  }

  const index = Number(args[0]) - 1;
  const group = Number.isInteger(index) ? groups[index] : null;
  if (!group) {
    await reply("Nomor grup tidak dikenal. Ketik /grup untuk melihat daftar.");
    return true;
  }
  const [, name, action] = args;
  if (!name) {
    await reply([`⚙️ Fitur di *${group.subject}*:`, ...statusLines(group.id), "", `Ubah: /fitur ${index + 1} <fitur> on|off`].join("\n"));
    return true;
  }
  const value = ON.has(String(action).toLowerCase()) ? true : OFF.has(String(action).toLowerCase()) ? false : null;
  if (!features.isFeature(name) || !features.FEATURES[name].available || value === null) {
    await reply(`Format: /fitur ${index + 1} <fitur> on|off. ${usage()}`);
    return true;
  }
  // Status admin dicek ulang tepat sebelum mengubah (bisa saja baru dicabut).
  const fresh = (await listGroups()).find((item) => item.id === group.id);
  if (!fromOwner && !fresh?.admin) {
    await reply("❌ Kamu sudah bukan admin grup itu.");
    return true;
  }
  const result = features.setGroupFeature(group.id, name, value, { phone: senderPhone, role: fromOwner ? "owner" : "admin" });
  if (!result.ok) {
    await reply(result.error === "dikunci_owner" ? `🔒 Fitur *${name}* dikunci owner, jadi belum bisa dinyalakan.` : "Gagal mengubah fitur.");
    return true;
  }
  await reply(`${result.after ? "✅" : "❌"} Fitur *${name}* di *${group.subject}* sekarang ${result.after ? "aktif" : "mati"}.`);
  return true;
}

module.exports = { handleFeatureCommand };
