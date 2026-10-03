// Kabari owner lewat DM WhatsApp bila backup harian gagal atau terlewat (owner 3 Okt:
// token GitHub bisa kedaluwarsa dan backup gagal diam-diam). scripts/backup.sh menulis
// data/logs/backup-status.json; bot memeriksanya berkala. Tiap kejadian dikabari sekali.
const fs = require("node:fs");
const path = require("node:path");
const memoryStore = require("./memory-store");
const { formatWit } = require("./agent/schedules");

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function monitorConfig() {
  return {
    statusFile: path.resolve(process.env.GRAD_BACKUP_STATUS_FILE || "data/logs/backup-status.json"),
    intervalMs: Math.max(1, envNumber("BACKUP_CHECK_INTERVAL_MIN", 30)) * 60_000,
    staleMs: Math.max(1, envNumber("BACKUP_STALE_HOURS", 26)) * 3_600_000,
  };
}

function readStatus(file) {
  try {
    const status = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isFinite(status?.at) ? status : null;
  } catch {
    return null;
  }
}

/**
 * Pesan yang perlu dikirim sekarang (atau null). Status pengiriman disimpan di
 * settings.backup_alert supaya restart bot tidak mengulang kabar yang sama.
 */
function pendingAlert({ status, now = Date.now(), staleMs, alert = {} }) {
  if (!status) return null; // backup belum pernah jalan di server ini
  if (!status.ok) {
    if (alert.failure_at === status.at) return null;
    return {
      key: { failure_at: status.at },
      text: `⚠️ Backup Grad GAGAL (${formatWit(status.at)}).\n${status.detail || "tanpa keterangan"}\n\nData belum tersimpan ke GitHub. Cek di VPS: data/logs/backup.log (sering karena token GitHub di ~/.netrc kedaluwarsa). Backup manual: ./scripts/backup.sh`,
    };
  }
  if (now - status.at > staleMs) {
    // Terlewat: dikabari sekali per 24 jam selama belum ada backup baru.
    if (alert.stale_for === status.at && now - (alert.stale_at || 0) < 24 * 3_600_000) return null;
    const hours = Math.round((now - status.at) / 3_600_000);
    return {
      key: { stale_for: status.at, stale_at: now },
      text: `⚠️ Backup Grad terakhir berhasil ${hours} jam lalu (${formatWit(status.at)}). Jadwal harian sepertinya tidak jalan; cek crontab di VPS (crontab -l) dan data/logs/backup.log.`,
    };
  }
  return null;
}

/**
 * @param {{ getSock: () => object, ownerPhone: () => string|null }} deps
 */
function startBackupMonitor({ getSock, ownerPhone, cfg = monitorConfig() } = {}) {
  const check = async () => {
    try {
      const phone = ownerPhone?.();
      const sock = getSock?.();
      if (!phone || !sock) return null;
      const settings = memoryStore.getAgentSettings();
      const alert = pendingAlert({ status: readStatus(cfg.statusFile), staleMs: cfg.staleMs, alert: settings.backup_alert || {} });
      if (!alert) return null;
      await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: alert.text });
      memoryStore.setAgentSettings({ backup_alert: { ...(settings.backup_alert || {}), ...alert.key } });
      console.log("[BACKUP] Owner dikabari soal backup");
      return alert;
    } catch (error) {
      console.warn("[BACKUP] Gagal mengabari owner:", error.message);
      return null;
    }
  };
  const first = setTimeout(check, 2 * 60_000);
  const timer = setInterval(check, cfg.intervalMs);
  first.unref?.();
  timer.unref?.();
  return { check, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { monitorConfig, pendingAlert, readStatus, startBackupMonitor };
