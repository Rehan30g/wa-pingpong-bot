const { createDb, getDefaultDb, closeDefaultDb } = require("./db");
const { runMigrations, CURRENT_SCHEMA_VERSION } = require("./migrations");
const { SqliteStorage, OptimisticConcurrencyError, LeaseConflictError } = require("./sqlite-storage");

/**
 * Membuat instance storage terisolasi baru (sangat cocok untuk test suite)
 */
async function createStorage(dbPath) {
  const db = await createDb(dbPath);
  await runMigrations(db);
  const storage = new SqliteStorage(db);
  await storage.loadEpochs();
  return {
    db,
    storage,
    close: async () => {
      if (storage._writeQueue) {
        await storage._writeQueue.catch(() => {});
      }
      return db.close();
    },
  };
}

let defaultStorageInstance = null;

async function getDefaultStorage() {
  if (!defaultStorageInstance) {
    const db = await getDefaultDb();
    await runMigrations(db);
    defaultStorageInstance = new SqliteStorage(db);
    await defaultStorageInstance.loadEpochs();
  }
  return defaultStorageInstance;
}

module.exports = {
  createStorage,
  getDefaultStorage,
  createDb,
  getDefaultDb,
  closeDefaultDb,
  runMigrations,
  CURRENT_SCHEMA_VERSION,
  SqliteStorage,
  OptimisticConcurrencyError,
  LeaseConflictError,
};
