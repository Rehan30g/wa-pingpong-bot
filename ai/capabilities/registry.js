// Registry untuk capability agen generasi berikutnya.
// Semua capability baru wajib didaftarkan secara eksplisit dan default nonaktif.
const capabilities = new Map();

function registerCapability(definition = {}) {
  const name = String(definition.name || "").trim();
  if (!name) throw new Error("Capability harus memiliki nama");
  if (capabilities.has(name)) throw new Error(`Capability sudah terdaftar: ${name}`);
  const stored = Object.freeze({
    enabled: false,
    risk: "high",
    scopes: [],
    ...definition,
    name,
  });
  capabilities.set(name, stored);
  return stored;
}

function getCapability(name) {
  return capabilities.get(String(name)) || null;
}

function listCapabilities() {
  return [...capabilities.values()];
}

module.exports = {
  getCapability,
  listCapabilities,
  registerCapability,
};
