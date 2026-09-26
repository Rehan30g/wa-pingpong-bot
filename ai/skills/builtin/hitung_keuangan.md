---
name: hitung_keuangan
title: Kalkulator keuangan
description: cicilan/kredit (anuitas atau flat), KPR, bunga tabungan/deposito, diskon bertingkat, persen kenaikan
requires: python
---
Selalu hitung dengan run_python, jangan hitung di kepala.
- Anuitas (KPR/kredit bank): `r = bunga_tahunan/12; cicilan = P*r/(1-(1+r)**-n)`.
- Flat (leasing motor/mobil, KTA tertentu): `cicilan = P/n + P*bunga_tahunan/12`.
- Bunga majemuk: `A = P*(1+r/m)**(m*t)`; deposito: potong pajak bunga 20% bila relevan.
- Diskon bertingkat: `harga*(1-d1)*(1-d2)` (bukan d1+d2).

1. Kalau jenis bunga tidak disebut, hitung anuitas dan sebut bahwa kalau skemanya flat hasilnya beda (sertakan angka flat juga).
2. Tampilkan: cicilan per bulan, total bayar, total bunga. Rupiah pakai titik (Rp1.234.567).
3. Tabel angsuran per bulan hanya kalau diminta; kalau panjang, buat gambar tabel/grafik (sisa pokok vs bunga) ke out/.
4. Ingatkan singkat bahwa angka final tergantung biaya admin/asuransi dari pemberi kredit. Ini hitungan, bukan nasihat investasi.
