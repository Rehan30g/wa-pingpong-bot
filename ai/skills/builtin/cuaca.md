---
name: cuaca
title: Cuaca & prakiraan
description: cuaca sekarang atau prakiraan beberapa hari di suatu kota
requires: python
web: false
---
Pakai Open-Meteo (gratis, tanpa key) lewat run_python. Geocoding dan prakiraan WAJIB dalam SATU run_python (tiap run butuh ±5 detik untuk menyalakan Python), dan cetak hasilnya sekaligus. Jangan tambah web_search kalau data Open-Meteo sudah ada; web_search hanya kalau Open-Meteo gagal.
```
import net
g = net.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": KOTA, "count": 1, "language": "id"}).json()["results"][0]
f = net.get("https://api.open-meteo.com/v1/forecast", params={
    "latitude": g["latitude"], "longitude": g["longitude"], "timezone": g.get("timezone", "auto"),
    "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    "forecast_days": 3}).json()
```
Kode cuaca WMO: 0 cerah, 1–3 cerah berawan/berawan, 45/48 berkabut, 51–57 gerimis, 61–67 hujan, 80–82 hujan lokal/deras, 95–99 badai petir.

1. Kota tidak disebut → pakai kota yang pernah disebut di obrolan/memori; kalau tidak ada, tanya.
2. Nama kota ambigu → sebut nama + provinsi hasil geocoding (`admin1`) di jawaban.
3. Jawaban ringkas: sekarang (suhu, terasa, kondisi), lalu hari ini/besok (min–maks, peluang hujan). Beri saran singkat bila relevan (bawa payung jika peluang hujan ≥ 60%).
