const path = require("node:path");
const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { cleanup } = setupIsolatedTestEnv("wa-test-documents-");
process.env.PYTHON_TIMEOUT_MS = "90000";
process.env.AI_DEBOUNCE_MS = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { createMockOpenRouter, toolCall } = require("./helpers/mock-openrouter");
const runner = require("../ai/sandbox/python-runner");
const reader = require("../ai/documents/reader");
const features = require("../ai/features");
const groupAgent = require("../ai/group-agent");

test.after(() => cleanup());

const ready = runner.documentsReady();
const opts = { skip: ready ? false : "sandbox dokumen belum disiapkan (npm run python:setup)" };
const FIXTURE = "fixture-docs";
const GROUP = "120363777000111@g.us";

// Buat file contoh sekali (di sandbox, pakai library yang sama dengan skill).
let fixtures = null;
async function makeFixtures() {
  if (fixtures) return fixtures;
  const code = String.raw`
from fpdf import FPDF
from PIL import Image
pdf = FPDF(); pdf.set_font("Helvetica", size=12)
for i, t in enumerate(["Laporan kas RT 05", "Anggaran konsumsi Rp2.500.000", "Kesimpulan: sisa kas Rp1.200.000 untuk lomba anak"], 1):
    pdf.add_page(); pdf.multi_cell(0, 8, f"Halaman {i}. {t}. " + "Isi laporan yang cukup panjang. " * 3)
pdf.output("out/laporan.pdf")
Image.new("RGB", (400, 560), "white").save("blank.png")
scan = FPDF(); scan.add_page(); scan.image("blank.png", x=0, y=0, w=210); scan.output("out/scan.pdf")
from docx import Document
d = Document(); d.add_heading("Notulen Karang Taruna", 0); d.add_paragraph("Keputusan: lomba tanggal 17 Agustus.")
t = d.add_table(rows=2, cols=2); t.rows[0].cells[0].text = "Tugas"; t.rows[0].cells[1].text = "PIC"; t.rows[1].cells[0].text = "Konsumsi"; t.rows[1].cells[1].text = "Sari"
d.save("out/notulen.docx")
from pptx import Presentation
p = Presentation()
for title, body in [("Rencana", "Jadwal acara"), ("Anggaran", "Total Rp3.250.000"), ("Penutup", "Terima kasih")]:
    s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = title; s.placeholders[1].text = body
p.save("out/slide.pptx")
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "Iuran"; ws.append(["Nama", "Iuran"]); ws.append(["Andi", 25000]); ws.append(["Sari", 50000]); wb.save("out/iuran.xlsx")
import zipfile
with zipfile.ZipFile("out/bom.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("word/document.xml", b"0" * (210 * 1024 * 1024))
`;
  const run = await runner.runPython({ chatId: FIXTURE, code });
  assert.equal(run.ok, true, run.error);
  const out = path.join(runner.workspaceFor(FIXTURE), "out");
  fixtures = Object.fromEntries(["laporan.pdf", "scan.pdf", "notulen.docx", "slide.pptx", "iuran.xlsx", "bom.docx"].map((name) => [name, fs.readFileSync(path.join(out, name))]));
  return fixtures;
}

test("baca PDF, Word, PowerPoint, Excel: isi terstruktur, pages, query, dan cache", opts, async () => {
  const f = await makeFixtures();
  const chatId = "120363777000222@g.us";
  const pdf = await reader.readDocument({ chatId, buffer: f["laporan.pdf"], fileName: "laporan.pdf" });
  assert.equal(pdf.ok, true, pdf.error);
  assert.equal(pdf.total, 3);
  assert.match(pdf.content, /--- halaman 3 ---\nHalaman 3\. Kesimpulan: sisa kas Rp1\.200\.000/);
  assert.equal(pdf.file, "inbox/laporan.pdf");

  const started = Date.now();
  const page2 = await reader.readDocument({ chatId, file: "inbox/laporan.pdf", pages: "2" });
  assert.match(page2.content, /^--- halaman 2 ---/);
  assert.doesNotMatch(page2.content, /halaman 3/);
  assert.ok(Date.now() - started < 2_000, "bacaan kedua memakai cache, tanpa sandbox");
  const search = await reader.readDocument({ chatId, file: "inbox/laporan.pdf", query: "lomba" });
  assert.match(search.content, /^--- halaman 3 ---/);

  const docx = await reader.readDocument({ chatId, buffer: f["notulen.docx"], fileName: "notulen.docx" });
  assert.match(docx.content, /# Notulen Karang Taruna\nKeputusan: lomba tanggal 17 Agustus\.\n\| Tugas \| PIC \|\n\| Konsumsi \| Sari \|/);
  const pptx = await reader.readDocument({ chatId, buffer: f["slide.pptx"], fileName: "slide.pptx", query: "total" });
  assert.equal(pptx.unit, "slide");
  assert.match(pptx.content, /^--- slide 2 ---\n# Anggaran\n• Total Rp3\.250\.000$/);
  const xlsx = await reader.readDocument({ chatId, buffer: f["iuran.xlsx"], fileName: "iuran.xlsx" });
  assert.match(xlsx.content, /--- sheet 1 \(Iuran\) ---\n# Sheet: Iuran\nNama \| Iuran\nAndi \| 25000\nSari \| 50000/);
});

test("penjaga: format lama, file di luar folder kerja, zip bomb, ukuran", opts, async () => {
  const f = await makeFixtures();
  const chatId = "120363777000333@g.us";
  assert.match((await reader.readDocument({ chatId, buffer: Buffer.from("x"), fileName: "lama.doc" })).error, /belum didukung/);
  assert.match((await reader.readDocument({ chatId, file: "../../../.env" })).error, /tidak ditemukan di folder kerja/);
  assert.match((await reader.readDocument({ chatId, buffer: f["bom.docx"], fileName: "bom.docx" })).error, /mencurigakan/);
  process.env.DOC_MAX_MB = "1";
  try {
    assert.match((await reader.readDocument({ chatId, buffer: Buffer.alloc(2 * 1_048_576), fileName: "besar.pdf" })).error, /lebih dari 1 MB/);
  } finally {
    delete process.env.DOC_MAX_MB;
  }
  assert.equal(reader.safeFileName("../../evil name?.pdf"), "evil name_.pdf");
});

test("PDF hasil scan: halaman tanpa teks dikirim ke OCR (sekali, lalu cache); OCR bisa dimatikan", opts, async () => {
  const f = await makeFixtures();
  reader.resetOcrUsage();
  const calls = [];
  const http = {
    post: async (endpoint, body) => {
      calls.push(body);
      return { choices: [{ message: { content: "--- halaman 1 ---\nSURAT UNDANGAN RAPAT\nSabtu 19.30 WIT" } }], usage: { cost: 0.0002 } };
    },
  };
  let cost = 0;
  const off = await reader.readDocument({ chatId: "120363777000444@g.us", buffer: f["scan.pdf"], fileName: "scan.pdf", ocr: false });
  assert.match(off.note, /OCR mati/);
  const chatId = "120363777000555@g.us";
  const doc = await reader.readDocument({ chatId, buffer: f["scan.pdf"], fileName: "scan.pdf", http, addCost: (c) => { cost += c; } });
  assert.equal(doc.ok, true, doc.error);
  assert.deepEqual(doc.ocr_pages, [1]);
  assert.match(doc.content, /SURAT UNDANGAN RAPAT/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugins[0].pdf.engine, "native");
  assert.equal(calls[0].messages[0].content[1].type, "file");
  assert.equal(cost, 0.0002);
  await reader.readDocument({ chatId, file: doc.file, http });
  assert.equal(calls.length, 1, "halaman yang sudah di-OCR tidak dikirim ulang");
});

test("agent loop: dokumen di grup → read_document; run_python membuat .docx → terkirim sebagai dokumen", opts, async () => {
  const f = await makeFixtures();
  try { fs.unlinkSync(process.env.FEATURES_FILE); } catch {}
  features.resetCache();
  groupAgent.resetHistories();
  groupAgent.setDocumentLoader(async (ref) => (ref?.key?.id === "doc" ? { buffer: f["laporan.pdf"], fileName: "laporan.pdf" } : null));
  const mock = await createMockOpenRouter({ decision: { choice: "ignore", confidence: 0.9 }, chat: ["ok"] }).start();
  try {
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, ...content }); return { key: { id: `b${sent.length}` } }; }, readMessages: async () => {}, sendPresenceUpdate: async () => {} };
    const base = { sock, groupId: GROUP, senderId: "62811", senderName: "Rehan", replyToBot: false, quotedText: "" };
    await groupAgent.processGroupMessage({ ...base, message: { key: { id: "doc", remoteJid: GROUP } }, text: "[dokumen: laporan.pdf · 3 hlm · 2 KB]", explicitMention: false, document: { name: "laporan.pdf", mime: "application/pdf", pages: 3 } });
    const entry = groupAgent.getHistory(GROUP).find((e) => e.message_key?.id === "doc");
    assert.equal(entry.document.name, "laporan.pdf");

    mock.script.decision = { choice: "reply", confidence: 0.95 };
    mock.script.chat = [
      { content: null, tool_calls: [toolCall("read_document", { entry_id: entry.entry_id, query: "sisa kas" })] },
      { content: null, tool_calls: [toolCall("run_python", { code: "from docx import Document\nd = Document(); d.add_paragraph('Sisa kas Rp1.200.000'); d.save('out/ringkasan.docx')" })] },
      "Sisa kasnya Rp1,2 juta, ringkasannya di file ini.",
    ];
    const result = await groupAgent.processGroupMessage({ ...base, message: { key: { id: "ask", remoteJid: GROUP } }, text: "@Grad sisa kas berapa? bikinin word-nya", explicitMention: true });
    const system = mock.state.chat.at(-3).messages[0].content;
    assert.match(system, /read_document/);
    const toolResult = mock.state.chat.at(-2).messages.find((m) => m.role === "tool");
    assert.match(toolResult.content, /sisa kas Rp1\.200\.000/);
    assert.match(toolResult.content, /untrusted_data/);
    assert.equal(result.action, "reply");
    const doc = sent.at(-1);
    assert.equal(doc.fileName, "ringkasan.docx");
    assert.equal(doc.mimetype, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.ok(Buffer.isBuffer(doc.document) && doc.document.length > 1000);
    assert.ok(groupAgent.getHistory(GROUP).some((e) => e.text === "[mengirim dokumen: ringkasan.docx]"));

    features.setGroupFeature(GROUP, "dokumen", false, { role: "admin" });
    await groupAgent.processGroupMessage({ ...base, message: { key: { id: "ask2", remoteJid: GROUP } }, text: "@Grad baca pdf tadi", explicitMention: true });
    assert.ok(!(mock.state.chat.at(-1).tools || []).some((t) => t.function?.name === "read_document"), "fitur mati → tool tidak ada");
  } finally {
    groupAgent.setDocumentLoader(null);
    await mock.stop();
  }
});
