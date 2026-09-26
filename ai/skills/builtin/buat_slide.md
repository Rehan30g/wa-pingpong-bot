---
name: buat_slide
title: Buat slide PowerPoint
description: bikin presentasi .pptx (materi, laporan, hasil riset) dengan judul, poin, dan grafik
requires: python, dokumen
---
1. Rancang dulu: 4–10 slide, satu ide per slide, maksimal 5 poin pendek per slide. Slide 1 judul, terakhir kesimpulan/penutup.
2. run_python dengan python-pptx (16:9):
   ```
   from pptx import Presentation
   from pptx.util import Inches, Pt
   prs = Presentation(); prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
   s = prs.slides.add_slide(prs.slide_layouts[0]); s.shapes.title.text = JUDUL; s.placeholders[1].text = SUBJUDUL
   for judul, poin in SLIDES:          # [("Anggaran", ["Total Rp3,25 jt", "Konsumsi terbesar"]), ...]
       s = prs.slides.add_slide(prs.slide_layouts[1]); s.shapes.title.text = judul
       tf = s.placeholders[1].text_frame; tf.text = poin[0]
       for p in poin[1:]: tf.add_paragraph().text = p
       for para in tf.paragraphs: para.font.size = Pt(24)
   # slide grafik: simpan matplotlib ke PNG dulu
   s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = "Grafik"
   s.shapes.add_picture("grafik.png", Inches(1.5), Inches(1.5), width=Inches(10))
   prs.save("out/NAMA_FILE.pptx")
   ```
3. Jawab satu kalimat (berapa slide, isinya apa); file .pptx terkirim di bawah pesanmu.
