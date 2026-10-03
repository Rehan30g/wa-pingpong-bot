---
name: kurs_mata_uang
title: Kurs & konversi mata uang
description: kurs terkini, konversi nominal antar mata uang, atau tren kurs beberapa hari/bulan
requires: python
web: false
---
Pakai API gratis tanpa key lewat run_python (`import net`):
- Kurs terkini (update harian): `net.get("https://open.er-api.com/v6/latest/USD").json()["rates"]["IDR"]`; ganti USD dengan kode mata uang asal.
- Riwayat/tren (kurs acuan ECB, hari kerja saja): `net.get("https://api.frankfurter.dev/v1/<AWAL>..<AKHIR>", params={"base": "USD", "symbols": "IDR"}).json()["rates"]` dengan tanggal YYYY-MM-DD → dict tanggal → {IDR: nilai}. Hitung tanggal dari waktu sekarang.

Langkah:
1. Pastikan kode mata uang (ISO 4217: USD, EUR, SGD, MYR, JPY, SAR, CNY, AUD…). "Dolar" tanpa keterangan = USD, "ringgit" = MYR, "riyal" = SAR.
2. Konversi: nominal × kurs; tampilkan Rupiah dengan pemisah titik tanpa desimal (Rp1.234.567), mata uang lain 2 desimal.
3. Untuk tren: hitung perubahan % awal→akhir, nilai tertinggi/terendah; bila diminta grafik, ikuti gaya skill grafik_data.
4. Sebutkan tanggal update kursnya dan bahwa kurs bank/money changer bisa sedikit berbeda.
