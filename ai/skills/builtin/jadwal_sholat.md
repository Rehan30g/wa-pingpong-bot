---
name: jadwal_sholat
title: Jadwal sholat
description: jadwal sholat/imsak hari ini atau tanggal tertentu di kota Indonesia (data Kemenag)
requires: python
---
Pakai API myquran (data Kemenag, jam sudah waktu lokal kota tersebut) lewat run_python:
```
import net
hasil = net.get("https://api.myquran.com/v2/sholat/kota/cari/" + NAMA_KOTA).json()["data"]
# hasil bisa berisi "KAB. X" dan "KOTA X": utamakan KOTA, kecuali pengguna menyebut kabupaten
lokasi = next((k for k in hasil if k["lokasi"].startswith("KOTA")), hasil[0])
j = net.get(f"https://api.myquran.com/v2/sholat/jadwal/{lokasi['id']}/{TANGGAL_YYYY_MM_DD}").json()["data"]["jadwal"]
print(lokasi["lokasi"], j)
```
1. Kota tidak disebut → pakai kota dari obrolan/memori; kalau tidak ada, tanya.
2. Tulis zona waktunya sesuai kota (WIB/WITA/WIT), jangan dikonversi.
3. Format ringkas satu baris per waktu: Imsak, Subuh, Dzuhur, Ashar, Maghrib, Isya. Kalau ditanya satu waktu saja (mis. "maghrib jam berapa"), jawab itu saja.
4. Untuk "ingetin tiap maghrib", buat jadwal lewat schedule bila fitur jadwal ada.
