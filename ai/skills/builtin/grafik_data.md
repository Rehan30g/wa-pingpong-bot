---
name: grafik_data
title: Grafik dari data
description: bikin grafik/diagram (garis, batang, pie) dari angka di chat, file, atau data API
requires: python
---
1. Kumpulkan datanya dulu (dari pesan, file workspace, atau API lewat `net.get`). Jangan mengarang angka; kalau datanya kurang, tanya singkat.
2. Pilih jenis: garis untuk tren waktu, batang untuk perbandingan kategori, pie hanya bila ≤ 6 bagian dari satu total.
3. run_python dengan gaya yang enak dibaca di HP:
   ```
   import matplotlib
   matplotlib.use("Agg")
   import matplotlib.pyplot as plt
   fig, ax = plt.subplots(figsize=(8, 4.5), dpi=120)
   # ... plot ...
   ax.set_title(JUDUL, fontsize=14, weight="bold"); ax.grid(alpha=0.3)
   for s in ("top", "right"): ax.spines[s].set_visible(False)
   fig.tight_layout(); fig.savefig("out/grafik.png")
   ```
   - label sumbu bahasa Indonesia, angka ribuan pakai titik (`f"{x:,.0f}".replace(",", ".")`);
   - tandai nilai terakhir/tertinggi dengan `ax.annotate` bila membantu;
   - tanggal ditulis pendek (`%d/%m`).
4. Jawab 1–2 kalimat berisi insight utama (naik/turun berapa, puncaknya kapan) dan sumber datanya. Grafik terkirim di bawah pesanmu.
