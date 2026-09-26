---
name: buat_excel
title: Buat/olah Excel
description: bikin spreadsheet .xlsx (iuran, patungan, jadwal, rekap) dengan rumus, atau olah Excel/CSV yang dikirim
requires: python, dokumen
---
Buat baru dengan openpyxl (rumus tetap hidup di Excel):
```
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
wb = Workbook(); ws = wb.active; ws.title = "Rekap"
ws.append(["Nama", "Iuran"])
for row in DATA: ws.append(row)            # [("Andi", 25000), ...]
n = ws.max_row
ws.append(["Total", f"=SUM(B2:B{n})"])
for c in ws[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="0F6E5A")
ws[f"A{n+1}"].font = Font(bold=True)
for row in ws.iter_rows(min_row=2, min_col=2, max_col=2):
    for c in row: c.number_format = '"Rp"#,##0'
ws.column_dimensions["A"].width = 18; ws.column_dimensions["B"].width = 14
ws.freeze_panes = "A2"
wb.save("out/NAMA_FILE.xlsx")
```
Olah file yang dikirim:
1. read_document(entry_id) dulu (file tersimpan di folder kerja, lihat field "file").
2. run_python dengan pandas: `df = pd.read_excel("inbox/data.xlsx", sheet_name=None)` (semua sheet) atau `pd.read_csv(...)`; hitung dengan pandas, jangan di kepala.
3. Kalau diminta file hasil, simpan ke out/ (`df.to_excel("out/hasil.xlsx", index=False)`); kalau cuma tanya angka, jawab angkanya saja.
Jawab singkat dengan angka kunci; file terkirim di bawah pesanmu.
