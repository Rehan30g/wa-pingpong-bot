const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

/**
 * Normalisasi path file SQLite ke URL format file:// yang didukung @libsql/client
 */
function pathToDbUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return `file:${resolved}`;
}

/**
 * Membuat koneksi database SQLite baru dengan konfigurasi WAL dan foreign_keys aktif
 */
async function createDb(dbPath = process.env.RUNTIME_DB_PATH || "./runtime.db") {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const url = pathToDbUrl(resolvedPath);
  const client = createClient({ url });

  // Konfigurasi performa dan integritas ACID
  await client.execute("PRAGMA journal_mode = WAL;");
  await client.execute("PRAGMA foreign_keys = ON;");
  await client.execute("PRAGMA busy_timeout = 5000;");
  await client.execute("PRAGMA synchronous = NORMAL;");

  let writeQueue = Promise.resolve();
  const serializeWrite = async (fn) => {
    const prev = writeQueue;
    let resolve;
    writeQueue = new Promise((r) => { resolve = r; });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      resolve();
    }
  };

  return {
    client,
    path: resolvedPath,
    url,
    execute: (...args) => client.execute(...args),
    batch: (...args) => serializeWrite(() => client.batch(...args)),
    transaction: async (...args) => {
      let release;
      const prev = writeQueue;
      writeQueue = new Promise((r) => { release = r; });
      await prev.catch(() => {});
      try {
        const tx = await client.transaction(...args);
        const origCommit = tx.commit.bind(tx);
        const origRollback = tx.rollback.bind(tx);
        let released = false;
        const done = () => {
          if (!released) {
            released = true;
            release();
          }
        };
        tx.commit = async () => {
          try {
            return await origCommit();
          } finally {
            done();
          }
        };
        tx.rollback = async () => {
          try {
            return await origRollback();
          } finally {
            done();
          }
        };
        return tx;
      } catch (err) {
        release();
        throw err;
      }
    },
    close: async () => {
      await writeQueue.catch(() => {});
      return client.close();
    },
  };
}

let defaultDbInstance = null;

async function getDefaultDb() {
  if (!defaultDbInstance) {
    defaultDbInstance = await createDb();
  }
  return defaultDbInstance;
}

async function closeDefaultDb() {
  if (defaultDbInstance) {
    try {
      defaultDbInstance.close();
    } catch {}
    defaultDbInstance = null;
  }
}

module.exports = {
  createDb,
  getDefaultDb,
  closeDefaultDb,
  pathToDbUrl,
};
