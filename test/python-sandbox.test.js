const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup, testDir } = setupIsolatedTestEnv("wa-test-python-");
process.env.WORKSPACE_DIR = path.join(testDir, "workspace");
process.env.PYTHON_TIMEOUT_MS = "45000";
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const runner = require("../ai/sandbox/python-runner");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");

test.after(() => cleanup());

const CHAT = "120363123000111@g.us";
const ready = runner.isReady();
const opts = { skip: ready ? false : "sandbox belum disiapkan (npm run python:setup)" };
const ROOT = path.resolve(__dirname, "..").split(path.sep).join("/");

test("hitung, grafik matplotlib, dan QR menghasilkan output + gambar di out/", opts, async () => {
  const calc = await runner.runPython({ chatId: CHAT, code: "import numpy as np\nprint(round(float(np.mean([20.5, 18.9, 24.4])), 2))\n2**100 % 97" });
  assert.equal(calc.ok, true, calc.error);
  assert.equal(calc.stdout.trim(), "21.27");
  assert.equal(calc.result, "16");

  const chart = await runner.runPython({ chatId: CHAT, code: "import matplotlib.pyplot as plt\nplt.bar(['a','b'],[1,2])\nplt.savefig('out/grafik.png', dpi=60)" });
  assert.equal(chart.ok, true, chart.error);
  assert.deepEqual(chart.images.map((i) => [i.name, i.mime]), [["grafik.png", "image/png"]]);

  const qr = await runner.runPython({ chatId: CHAT, code: "import qrcode\nqrcode.make('https://example.com').save('out/qr.png')\nimport os\nos.listdir('out')" });
  assert.equal(qr.ok, true, qr.error);
  assert.deepEqual(qr.images.map((i) => i.name), ["qr.png"], "out/ hanya berisi hasil run ini");
  assert.ok(qr.files.includes("out/qr.png"));
});

test("internet hanya lewat jembatan bot (net.get/post) yang disaring", opts, async () => {
  const seen = [];
  const requester = async (request) => {
    seen.push(request);
    return { status: 200, url: request.url, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ harga: 1234 })) };
  };
  const run = await runner.runPython({
    chatId: CHAT,
    code: "r = net.get('https://api.example.com/emas', params={'kota': 'jayapura'})\nprint(r.status_code, r.json()['harga'])\np = net.post('https://api.example.com/x', json={'a': 1})\nprint(p.ok)",
    requester,
  });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.stdout.trim(), "200 1234\nTrue");
  assert.deepEqual(seen.map((r) => [r.method, r.url]), [["GET", "https://api.example.com/emas?kota=jayapura"], ["POST", "https://api.example.com/x"]]);
  assert.equal(seen[1].headers["Content-Type"], "application/json");
});

test("keamanan: .env tak terlihat, jembatan JS kosong, tanpa env rahasia, loop dihentikan", opts, async () => {
  const env = await runner.runPython({ chatId: CHAT, code: `open("${ROOT}/.env").read()` });
  assert.equal(env.ok, false);
  assert.match(env.error, /No such file/);
  const js = await runner.runPython({ chatId: CHAT, code: "from pyodide.code import run_js\nrun_js(\"process.getBuiltinModule('fs').readFileSync('x')\")" });
  assert.equal(js.ok, false);
  const secrets = await runner.runPython({ chatId: CHAT, code: "import os\nsorted(os.environ)" });
  assert.doesNotMatch(secrets.result, /OPENROUTER|API_KEY|D:\//);
  const mount = await runner.runPython({ chatId: CHAT, code: `import pyodide_js\npyodide_js.mountNodeFS("/bot", "${ROOT}")` });
  assert.equal(mount.ok, false);
  const loop = await runner.runPython({ chatId: CHAT, code: "while True:\n    pass", cfg: { ...runner.pythonConfig(), timeoutMs: 5_000 } });
  assert.match(loop.error, /waktu habis/);
});

test("out/: hasil run sebelumnya (mis. media_edit) tidak dihapus; hanya file baru/berubah yang dikirim", opts, async () => {
  const chat = "120363123000333@g.us";
  const out = path.join(runner.workspaceFor(chat), "out");
  fs.writeFileSync(path.join(out, "edit_sticker.webp"), Buffer.from("RIFF0000WEBP"));
  const first = await runner.runPython({ chatId: chat, code: "from PIL import Image\nImage.new('RGB',(8,8)).save('out/a.png')" });
  assert.deepEqual(first.images.map((i) => i.name), ["a.png"]);
  const second = await runner.runPython({ chatId: chat, code: "from PIL import Image\nImage.new('RGB',(8,8)).save('out/b.png')" });
  assert.deepEqual(second.images.map((i) => i.name), ["b.png"]);
  assert.ok(fs.existsSync(path.join(out, "edit_sticker.webp")), "hasil media_edit tetap ada");
});

test("workspace per chat terpisah dan file bertahan antar run", opts, async () => {
  await runner.runPython({ chatId: CHAT, code: "open('catatan.txt','w').write('halo')" });
  const same = await runner.runPython({ chatId: CHAT, code: "open('catatan.txt').read()" });
  assert.equal(same.result, "halo");
  const other = await runner.runPython({ chatId: "120363123000222@g.us", code: "import os\nos.path.exists('catatan.txt')" });
  assert.equal(other.result, "False");
});

test("agent loop: python aktif default, bisa dikunci owner; gambar hasil run_python dikirim ke grup", opts, async () => {
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
  const mock = await createMockOpenRouter({
    chat: [
      "Python belum dibuka owner.",
      { content: null, tool_calls: [toolCall("run_python", { code: "import qrcode\nqrcode.make('https://wa.me/62811').save('out/qr.png')" })] },
      "Ini QR-nya.",
    ],
  }).start();
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const args = (id) => ({ sock, message: { key: { id, remoteJid: CHAT } }, groupId: CHAT, senderId: "62811", senderName: "Rehan", text: "@Grad bikinin QR wa.me/62811", explicitMention: true, replyToBot: false, quotedText: "" });
    features.setGlobalLock("python", true, { role: "owner" });
    await groupAgent.processGroupMessage(args("q1"));
    assert.ok(!mock.state.chat[0].tools.some((t) => t.function?.name === "run_python"), "dikunci owner → tidak ditawarkan");
    assert.match(mock.state.chat[0].messages[0].content, /sedang dimatikan admin\/owner di chat ini: Python sandbox/, "Grad tahu fiturnya dimatikan, bukan tidak mampu");

    features.setGlobalLock("python", false, { role: "owner" });
    const result = await groupAgent.processGroupMessage(args("q2"));
    assert.ok(mock.state.chat[1].tools.some((t) => t.function?.name === "run_python"));
    assert.equal(result.action, "reply");
    assert.deepEqual(result.media, ["qr.png"]);
    assert.deepEqual(sent.slice(-2).map((s) => (s.image ? `IMG ${s.mimetype}` : s.text)), ["Ini QR-nya.", "IMG image/png"]);
    assert.equal(sent.at(-1).jid, CHAT);
  } finally {
    await mock.stop();
    features.setGlobalLock("python", false, { role: "owner" });
  }
});

// Kasus nyata 27 Sep: "file isi hati" disimpan .txt, tidak terkirim, tapi Grad bilang "udah dikirim di bawah".
test("file .txt di out/ ikut terkirim sebagai dokumen; format lain dilaporkan tidak terkirim", opts, async () => {
  const run = await runner.runPython({ chatId: CHAT, code: "open('out/isi_hati.txt','w').write('jujur semua')\nopen('out/rahasia.bin','wb').write(b'x')" });
  assert.deepEqual(run.documents.map((doc) => [doc.name, doc.mime]), [["isi_hati.txt", "text/plain"]]);
  assert.deepEqual(run.notSent, [{ name: "rahasia.bin", reason: "format .bin tidak dikirim" }]);
  const { executeTool } = require("../ai/agent/tools");
  const ctx = { python: { run: async () => run }, outbox: { media: [] } };
  const result = JSON.parse((await executeTool({ name: "run_python", ok: true, arguments: { code: "x" } }, ctx)).content).result;
  assert.deepEqual(result.documents_to_send, ["isi_hati.txt"]);
  assert.equal(result.not_sent[0].name, "rahasia.bin");
  assert.match(result.not_sent_note, /jangan bilang sudah dikirim/);
  assert.deepEqual(ctx.outbox.media.map((item) => item.kind), ["document"]);
});

test("gradzip: zip berpassword AES-256 & ZipCrypto dari sandbox, ikut terkirim sebagai dokumen", opts, async () => {
  const run = await runner.runPython({ chatId: CHAT, code: "import gradzip, zipfile\nopen('isi.txt','w').write('jujur')\nprint(gradzip.make_zip('out/a.zip', ['isi.txt'], password='pw1'))\nprint(gradzip.make_zip('out/w.zip', {'x.txt': 'halo'}, password='pw1', method='zipcrypto'))\nz = zipfile.ZipFile('out/w.zip')\nprint(z.read('x.txt', pwd=b'pw1'))\ninfo = zipfile.ZipFile('out/a.zip').infolist()[0]\nprint(info.compress_type, info.flag_bits & 1)" });
  assert.equal(run.ok, true, run.error || run.stderr);
  assert.match(run.stdout, /'method': 'aes'/);
  assert.match(run.stdout, /b'halo'/, "ZipCrypto terbaca zipfile dengan password");
  assert.match(run.stdout, /99 1/, "AES = metode 99, terenkripsi");
  assert.deepEqual(run.documents.map((doc) => doc.mime), ["application/zip", "application/zip"]);
  const failed = await runner.runPython({ chatId: CHAT, code: "import gradzip\ngradzip.make_zip('out/rusak.zip', ['tidak_ada.txt'], password='x')" });
  assert.equal(failed.ok, false);
  assert.ok(!failed.documents.length, "zip gagal tidak meninggalkan file untuk dikirim");
});
