// Evaluasi lokal 60 skenario berbeda dari suite test aktual. Tidak menjalankan WhatsApp produksi.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const scenarios = {
  chat_routing: [
    "DM dari nomor di luar whitelist diabaikan total", "DM dari orang dikenal dibalas", "DM ignore hanya", "permintaan menyebarkan pesan ditolak", "processGroupMessage mengirim media", "processGroupMessage mengirim frame video", "GLM dapat memilih pesan lama", "pesan saat evaluasi berjalan", "pesan dalam jendela debounce", "Inbound Dispatcher: pesan grup biasa tanpa mention",
  ],
  multi_step_tools: [
    "Happy multi-step", "Bad planner JSON", "Bad planner schema", "Plan step bounds exceeded", "Capability deny - capability tidak terdaftar", "Capability deny - capability dinonaktifkan", "Timeout / abort in capability", "Retry budget exhausted", "Verifier deterministic output mismatch", "Acceptance criteria verification", "replan atomik setelah note tidak ditemukan", "Checkpoint per langkah tersimpan", "Inbound /task ingat", "asset privat terikat chat/task", "stiker diproses dalam child process",
  ],
  memory_privacy: [
    "migrasi v2 tanpa provenance", "reset grup membuang profil", "profil legacy dan profil grup lain", "reset saat compact berjalan", "compact grup mengulang JSON", "compact grup gagal tertutup", "fakta bersumber dibatasi chat", "router dan capability fakta memori", "fakta berkunci yang bertentangan", "riwayat DM terpisah dari riwayat grup",
  ],
  crash_retry_delivery: [
    "Crash pre-send vs restart", "Crash post-send vs restart", "Fencing takeover: worker usang", "Restart resume dari checkpoint", "Startup recovery: memulihkan task/job", "Process lock dipakai lifecycle", "Duplikasi idempotency first-write-wins", "Cancellation / context epoch bump membatalkan outbox", "Outbox crash matrix", "Lease expiry takeover",
  ],
  attacks_permissions: [
    "Model injection attempt - destination injected", "Model injection attempt - idempotencyKey injected", "Model injection attempt - policy/approval injected", "Raw WhatsApp LID ditolak di inbox", "Approval argument hash mismatch", "web menolak IP privat", "redirect se-host ke DNS privat", "Audit secret redaction", "shadow inbound menghasilkan zero external send", "dispatcher agent menolak grup tak diizinkan",
  ],
  scheduler_budget: [
    "job reminder terkirim walau DM proaktif dimatikan", "job proactive_checkin memakai gerbang aman", "gerbang DM proaktif: whitelist", "Scheduler proaktif off vs emergency pause", "Budget survives restart",
  ],
};

const script = require("../package.json").scripts.test;
const testFiles = [...script.matchAll(/test\/[\w-]+\.test\.js/g)].map((match) => match[0]);
if (testFiles.length < 1) throw new Error("eval_test_files_missing");
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
if (run.error) throw run.error;
const tap = String(run.stdout || "");
const passedNames = [...tap.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1].replace(/\\#/g, "#"));
const failedCount = Number((/^# fail (\d+)$/m.exec(tap) || [])[1] || 0);
const skippedCount = Number((/^# skipped (\d+)$/m.exec(tap) || [])[1] || 0);
const todoCount = Number((/^# todo (\d+)$/m.exec(tap) || [])[1] || 0);
const used = new Set();
const selected = {};
for (const [category, needles] of Object.entries(scenarios)) {
  selected[category] = needles.map((needle) => {
    const matches = passedNames.filter((name) => name.includes(needle));
    if (matches.length !== 1 || used.has(matches[0])) throw new Error(`eval_manifest_mismatch:${category}:${needle}:${matches.length}`);
    used.add(matches[0]);
    return matches[0];
  });
}
const totals = Object.fromEntries(Object.entries(selected).map(([name, entries]) => [name, entries.length]));
const report = {
  date_utc: new Date().toISOString(),
  scope: "local_mock_and_fault_injection_only",
  release_ready: false,
  test_exit_code: run.status,
  failed_count: failedCount,
  skipped_count: skippedCount,
  todo_count: todoCount,
  total_suite_tests: Number((/^# tests (\d+)$/m.exec(tap) || [])[1] || 0),
  selected_unique_scenarios: used.size,
  category_counts: totals,
  selected,
  external_gates_pending: ["shadow_24h", "canary_48h_30_tasks", "user_whatsapp_test", "human_naturalness_review"],
};
const output = process.argv[2];
if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ date_utc: report.date_utc, test_exit_code: report.test_exit_code, total_suite_tests: report.total_suite_tests, selected_unique_scenarios: report.selected_unique_scenarios, category_counts: totals, release_ready: false })}\n`);
if (run.status !== 0 || failedCount !== 0 || skippedCount !== 0 || todoCount !== 0 || report.total_suite_tests < 60 || used.size !== 60) process.exitCode = 1;
