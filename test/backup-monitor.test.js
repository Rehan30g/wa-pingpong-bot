const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-backup-");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const test = require("node:test");
const assert = require("node:assert");
const memoryStore = require("../ai/memory-store");
const { pendingAlert, startBackupMonitor } = require("../ai/backup-monitor");

test.after(() => cleanup());
const HOUR = 3_600_000;

test("kapan owner dikabari: gagal (sekali per kejadian), terlewat >26 jam (sekali per hari), berhasil = diam", () => {
  const now = Date.now();
  const staleMs = 26 * HOUR;
  assert.equal(pendingAlert({ status: null, now, staleMs }), null, "belum pernah backup");
  assert.equal(pendingAlert({ status: { ok: true, at: now - HOUR }, now, staleMs }), null);
  const failed = pendingAlert({ status: { ok: false, at: now, detail: "baris 66: git push" }, now, staleMs });
  assert.match(failed.text, /Backup Grad GAGAL/);
  assert.match(failed.text, /git push/);
  assert.equal(pendingAlert({ status: { ok: false, at: now }, now, staleMs, alert: { failure_at: now } }), null, "kegagalan yang sama tidak dikirim ulang");
  const stale = pendingAlert({ status: { ok: true, at: now - 30 * HOUR }, now, staleMs });
  assert.match(stale.text, /30 jam lalu/);
  assert.equal(pendingAlert({ status: { ok: true, at: now - 30 * HOUR }, now, staleMs, alert: stale.key }), null, "terlewat: tidak diulang dalam 24 jam");
});

test("monitor mengirim DM ke owner sekali, lalu diam walau bot restart", async () => {
  memoryStore.resetAllMemory();
  const statusFile = path.join(testDir, "backup-status.json");
  fs.writeFileSync(statusFile, JSON.stringify({ ok: false, at: Date.now(), detail: "token kedaluwarsa" }));
  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return {}; } };
  const cfg = { statusFile, intervalMs: HOUR, staleMs: 26 * HOUR };
  const first = startBackupMonitor({ getSock: () => sock, ownerPhone: () => "6281111110003", cfg });
  await first.check();
  first.stop();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, "6281111110003@s.whatsapp.net");
  assert.match(sent[0].text, /token kedaluwarsa/);
  const second = startBackupMonitor({ getSock: () => sock, ownerPhone: () => "6281111110003", cfg });
  await second.check();
  second.stop();
  assert.equal(sent.length, 1, "setelah 'restart' tidak dikirim lagi");
  const noOwner = startBackupMonitor({ getSock: () => sock, ownerPhone: () => null, cfg });
  assert.equal(await noOwner.check(), null, "owner belum dikenali → tidak mengirim");
  noOwner.stop();
});

test("scripts/backup.sh yang gagal menulis status gagal (tanpa push apa pun)", { skip: process.platform === "win32" ? "bash" : false }, () => {
  const statusFile = path.join(testDir, "status-gagal.json");
  const result = spawnSync("bash", [path.join(__dirname, "..", "scripts", "backup.sh")], {
    env: { ...process.env, GRAD_BACKUP_PASS_FILE: path.join(testDir, "tidak-ada"), GRAD_BACKUP_STATUS_FILE: statusFile, GRAD_BACKUP_REPO_DIR: path.join(testDir, "repo") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.ok, false);
  assert.match(status.detail, /kata sandi/);
  assert.equal(fs.existsSync(path.join(testDir, "repo")), false, "tidak menyentuh repo backup");
});
