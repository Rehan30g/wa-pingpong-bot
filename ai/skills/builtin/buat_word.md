---
name: buat_word
title: Buat/edit dokumen Word
description: bikin dokumen Word .docx (surat, proposal, notulen) atau isi/ubah .docx yang dikirim
requires: python, dokumen
---
Buat baru dengan python-docx:
```
from docx import Document
from docx.shared import Pt
doc = Document()
doc.styles["Normal"].font.name = "Calibri"; doc.styles["Normal"].font.size = Pt(11)
doc.add_heading(JUDUL, 0)
doc.add_heading("Bagian", level=1)
doc.add_paragraph("Paragraf…")
doc.add_paragraph("poin satu", style="List Bullet")
t = doc.add_table(rows=1, cols=2); t.style = "Table Grid"
t.rows[0].cells[0].text, t.rows[0].cells[1].text = "Tugas", "PIC"
for a, b in [("Konsumsi", "Sari")]:
    c = t.add_row().cells; c[0].text, c[1].text = a, b
doc.save("out/NAMA_FILE.docx")
```
Edit/isi template yang dikirim:
1. read_document(entry_id) dulu supaya file tersimpan di folder kerja (lihat field "file", mis. inbox/surat.docx) dan kamu tahu isinya.
2. run_python: `doc = Document("inbox/surat.docx")`, ganti teks per paragraf/sel (`for p in doc.paragraphs: if "{{nama}}" in p.text: ...`; ganti di level run bila ingin format tetap), lalu simpan ke out/ dengan nama baru.
Jawab satu kalimat; file .docx terkirim di bawah pesanmu. Kalau diminta PDF, pakai skill buat_pdf (konversi Word→PDF tidak tersedia).
