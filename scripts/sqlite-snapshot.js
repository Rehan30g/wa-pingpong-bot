// Salinan SQLite yang konsisten walau bot sedang menulis (dipakai scripts/backup.sh).
//   node scripts/sqlite-snapshot.js <sumber.db> <tujuan.db>
const { DatabaseSync } = require("node:sqlite");

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("pakai: node scripts/sqlite-snapshot.js <sumber.db> <tujuan.db>");
  process.exit(2);
}
const db = new DatabaseSync(source, { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
