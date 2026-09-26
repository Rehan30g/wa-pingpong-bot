---
name: patungan
title: Patungan / bagi tagihan
description: bagi tagihan makan/jalan-jalan per orang, termasuk pajak, service, ongkir, diskon, dan siapa transfer ke siapa
requires: python
---
1. Kumpulkan: daftar item + harga + siapa yang pesan, item bersama (dibagi rata ke yang ikut), pajak/PB1 & service (%), ongkir/biaya lain, diskon/voucher, dan siapa yang sudah bayar berapa. Kalau ada foto struk, baca dari gambarnya. Tanya singkat hanya bila sesuatu yang penting tidak jelas.
2. WAJIB hitung dengan run_python memakai template ini (isi datanya saja; jangan hitung di kepala):
   ```
   items = [  # (nama item, harga total, [siapa saja yang menanggung])
       ("nasi goreng", 35000, ["Rehan"]),
       ("es teh x2", 10000, ["Rehan", "Budi"]),
   ]
   pajak, service, ongkir, diskon = 0.10, 0.0, 0, 0   # persen sebagai desimal, rupiah untuk ongkir/diskon
   sudah_bayar = {"Rehan": None}   # None = bayar semua tagihan; atau angka rupiah
   sub = {}
   for _, harga, orang in items:
       for o in orang: sub[o] = sub.get(o, 0) + harga / len(orang)
   subtotal = sum(sub.values())
   total = subtotal * (1 + pajak + service) + ongkir - diskon
   bagian = {o: s / subtotal * (subtotal * (1 + pajak + service) - diskon) + ongkir / len(sub) for o, s in sub.items()}
   bulat = {o: round(v / 100) * 100 for o, v in bagian.items()}
   payer = next(iter(sudah_bayar))
   bulat[payer] += round(total) - sum(bulat.values())   # selisih pembulatan ke pembayar
   assert abs(sum(bulat.values()) - round(total)) < 1, "jumlah per orang harus sama dengan total"
   bayar = {o: (round(total) if v is None else v) for o, v in sudah_bayar.items()}
   saldo = {o: bayar.get(o, 0) - bulat[o] for o in bulat}   # + = kelebihan bayar
   transfer = []
   utang = sorted([(o, -s) for o, s in saldo.items() if s < 0], key=lambda x: -x[1])
   piutang = sorted([(o, s) for o, s in saldo.items() if s > 0], key=lambda x: -x[1])
   while utang and piutang:
       (a, x), (b, y) = utang[0], piutang[0]
       n = min(x, y); transfer.append((a, b, n))
       utang[0], piutang[0] = (a, x - n), (b, y - n)
       if utang[0][1] == 0: utang.pop(0)
       if piutang[0][1] == 0: piutang.pop(0)
   print(round(total), bulat, transfer)
   ```
3. Tulis angka PERSIS dari output Python, jangan diubah. Format WhatsApp, satu baris per orang:
   *Nama*: Rp44.000
   lalu "Transfer:" (A → B Rp…) bila ada. Tutup dengan total keseluruhan.
4. Tawarkan simpan hasilnya sebagai catatan (note_write) bila fitur catatan ada.
