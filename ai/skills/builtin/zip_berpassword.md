---
name: zip_berpassword
title: Zip berpassword
description: bungkus file/teks jadi .zip yang dikunci password (AES-256 atau kompatibel Windows)
requires: python
---
1. Kumpulkan isinya: file di folder kerja (hasil run_python sebelumnya, dokumen di `inbox/`, gambar di `out/`) atau teks langsung.
2. Password: pakai yang diminta pengguna. Kalau tidak diberi, buat acak 10 karakter dan sebutkan di jawaban (jangan pakai password yang sama berulang).
3. Jalankan run_python dengan modul bawaan `gradzip` (JANGAN pakai zipfile/pyminizip/pyzipper, tidak bisa):
   ```
   import gradzip
   gradzip.make_zip("out/nama.zip", ["out/qr.png", "catatan.txt"], password="…")          # file
   gradzip.make_zip("out/nama.zip", {"isi.txt": "teks langsung"}, password="…")           # teks
   ```
   Default `method="aes"` (AES-256: dibuka 7-Zip, WinRAR, ZArchiver/RAR di HP). Kalau pengguna pakai Windows Explorer atau AES gagal dibuka, buat ulang dengan `method="zipcrypto"` (terbuka di mana saja, tapi keamanannya lemah; sebutkan itu).
4. File .zip di out/ otomatis terkirim sebagai dokumen. Jawab singkat: isinya apa, passwordnya (kalau kamu yang membuat), dan aplikasi untuk membukanya. Kalau password dari pengguna, jangan tulis ulang password itu di grup.
