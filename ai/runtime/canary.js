/**
 * Canary Manager & Fail-Closed Guard untuk Mode Agen (Fase 3)
 *
 * Persyaratan:
 * 1. Mode 'agent' wajib membatasi efek eksternal pada allowlist (owner + test group / canary).
 * 2. Bila allowlist kosong, FAIL CLOSED (nol efek eksternal).
 * 3. Mode 'shadow' selalu menghasilkan nol send eksternal (simulated outbox only).
 * 4. Mode 'legacy' dipertahankan sesuai konfigurasi eksisting bot.
 */

const fs = require("node:fs");
const engineConfig = require("./engine-config");

class CanaryManager {
  constructor({
    ownerPn = null,
    allowedChats = null,
    dataFile = null,
  } = {}) {
    this.customOwnerPn = ownerPn;
    this.customAllowedChats = allowedChats;
    this.dataFile = dataFile || process.env.BOT_DATA_FILE || "./data.json";
  }

  _normalizeNumber(val) {
    if (!val) return "";
    const digits = String(val).replace(/\D/g, "");
    if (digits.startsWith("0")) return `62${digits.slice(1)}`;
    return digits;
  }

  getOwnerPn() {
    if (this.customOwnerPn) return this._normalizeNumber(this.customOwnerPn);
    if (process.env.AGENT_CANARY_OWNER) {
      return this._normalizeNumber(process.env.AGENT_CANARY_OWNER);
    }
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
        if (raw.owner) {
          return this._normalizeNumber(raw.owner);
        }
      }
    } catch {}
    return null;
  }

  getAllowedChats() {
    if (Array.isArray(this.customAllowedChats)) {
      return new Set(this.customAllowedChats.map((s) => String(s).trim()).filter(Boolean));
    }
    const envList = process.env.AGENT_CANARY_CHATS || process.env.CANARY_ALLOWLIST;
    if (envList) {
      return new Set(
        envList
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    return new Set();
  }

  isOwner(actorPn) {
    const ownerPn = this.getOwnerPn();
    if (!ownerPn || !actorPn) return false;
    const normalized = this._normalizeNumber(actorPn);
    return normalized === ownerPn;
  }

  isCanaryChat(chatId) {
    if (!chatId) return false;
    const allowed = this.getAllowedChats();
    return allowed.has(String(chatId).trim());
  }

  /**
   * Menentukan apakah suatu chat atau actor diizinkan untuk efek keluar di mode saat ini.
   * Return:
   * - true: diizinkan
   * - false: ditolak (fail-closed bila mode agent dan allowlist kosong)
   */
  isAllowed({ chatId, actorPn, engineMode = null } = {}) {
    const mode = engineMode || engineConfig.getEngineMode();

    if (mode === engineConfig.ENGINE_MODES.LEGACY) {
      return true;
    }

    if (mode === engineConfig.ENGINE_MODES.SHADOW) {
      // Shadow mode ZERO external sends
      return false;
    }

    if (mode === engineConfig.ENGINE_MODES.AGENT) {
      const allowedChats = this.getAllowedChats();
      const ownerPn = this.getOwnerPn();

      // Bila allowlist kosong (tidak ada allowed chats dan tidak ada owner), FAIL CLOSED!
      if (allowedChats.size === 0 && !ownerPn) {
        return false;
      }

      if (actorPn && this.isOwner(actorPn)) {
        return true;
      }

      if (chatId && this.isCanaryChat(chatId)) {
        return true;
      }

      return false;
    }

    return false;
  }
}

module.exports = {
  CanaryManager,
};
