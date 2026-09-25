/**
 * Engine Configuration & Feature Flags untuk Runtime Durable (Fase 2)
 *
 * Engine modes:
 * - 'legacy' (default): Mempertahankan 100% perilaku bot produksi eksisting.
 * - 'shadow': Mengevaluasi pipeline durable di latar belakang tanpa efek eksternal:
 *             - TIDAK mengirim WhatsApp.
 *             - TIDAK menulis file memori produksi (ai-memory.json).
 *             - TIDAK membuat job jadwal produksi (agent-jobs.json).
 *             - Menggunakan database SQLite terpisah (runtime-shadow.db).
 * - 'agent': Mode penuh agen otonom (belum diaktifkan untuk pengguna nyata di Fase 2).
 */

const ENGINE_MODES = Object.freeze({
  LEGACY: "legacy",
  SHADOW: "shadow",
  AGENT: "agent",
});

function getEngineMode() {
  const mode = String(process.env.RUNTIME_ENGINE_MODE || ENGINE_MODES.LEGACY).toLowerCase().trim();
  if (Object.values(ENGINE_MODES).includes(mode)) {
    return mode;
  }
  return ENGINE_MODES.LEGACY;
}

function isLegacy() {
  return getEngineMode() === ENGINE_MODES.LEGACY;
}

function isShadow() {
  return getEngineMode() === ENGINE_MODES.SHADOW;
}

function isAgent() {
  return getEngineMode() === ENGINE_MODES.AGENT;
}

function canSendExternal() {
  if (isLegacy()) return true;
  if (isShadow()) return false; // Zero external WhatsApp sends in shadow mode
  return true;
}

function canWriteProductionMemory() {
  if (isShadow()) return false;
  return true;
}

function canScheduleProductionJobs() {
  if (isShadow()) return false;
  return true;
}

module.exports = {
  ENGINE_MODES,
  getEngineMode,
  isLegacy,
  isShadow,
  isAgent,
  canSendExternal,
  canWriteProductionMemory,
  canScheduleProductionJobs,
};
