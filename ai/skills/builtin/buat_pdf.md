---
name: buat_pdf
title: Buat PDF
description: bikin file PDF (notulen, laporan, surat, daftar, rangkuman) yang dikirim sebagai dokumen
requires: python, dokumen
---
1. Susun isinya dulu (judul, paragraf, poin, tabel kecil) dari permintaan/obrolan. Jangan mengarang data.
2. run_python dengan fpdf2 + font DejaVu (mendukung —, •, huruf beraksen). Selalu tulis lewat fungsi tulis() supaya baris berikutnya mulai dari kiri:
   ```
   import os, matplotlib
   from fpdf import FPDF
   FONT = os.path.join(matplotlib.get_data_path(), "fonts/ttf")
   pdf = FPDF(format="A4"); pdf.set_margins(18, 18, 18); pdf.set_auto_page_break(True, 18)
   pdf.add_font("DejaVu", "", f"{FONT}/DejaVuSans.ttf"); pdf.add_font("DejaVu", "B", f"{FONT}/DejaVuSans-Bold.ttf")
   def tulis(teks, size=11, style="", h=6, gray=0, after=1):
       pdf.set_font("DejaVu", style, size); pdf.set_text_color(gray)
       pdf.multi_cell(0, h, teks, new_x="LMARGIN", new_y="NEXT"); pdf.ln(after)
   pdf.add_page()
   tulis(JUDUL, 16, "B", 9)
   tulis(SUBJUDUL_ATAU_TANGGAL, 10, gray=90, after=4)
   tulis("Bagian", 12, "B", 7)
   tulis("Paragraf…")
   tulis("• poin satu\n• poin dua", after=3)
   # tabel: baris pertama = header
   pdf.set_font("DejaVu", "", 10)
   with pdf.table(col_widths=(60, 40), text_align="LEFT") as table:
       for row in [["Tugas", "PIC"], ["Konsumsi", "Sari"]]:
           r = table.row()
           for cell in row: r.cell(str(cell))
   pdf.output("out/NAMA_FILE.pdf")
   ```
   Nama file deskriptif tanpa spasi (mis. out/notulen-rapat-27-09.pdf). Grafik: simpan PNG dulu lalu pdf.image("grafik.png", w=170).
3. Jawab satu kalimat; file PDF terkirim di bawah pesanmu.
