---
name: qr_code
title: Bikin QR code
description: bikin QR dari teks/link, WiFi, nomor WA, atau kontak (vCard)
requires: python
---
1. Tentukan isi QR:
   - link/teks biasa: apa adanya (tambahkan https:// bila link tanpa skema);
   - WiFi: `WIFI:T:WPA;S:<nama wifi>;P:<password>;;` (T:nopass bila tanpa password);
   - chat WhatsApp: `https://wa.me/<nomor 62…>` (+ `?text=<teks ter-encode>` bila diminta);
   - kontak: vCard `BEGIN:VCARD\nVERSION:3.0\nFN:<nama>\nTEL:<nomor>\nEND:VCARD`.
2. Jalankan run_python:
   ```
   import qrcode
   qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=3)
   qr.add_data(ISI); qr.make(fit=True)
   qr.make_image(fill_color="black", back_color="white").save("out/qr.png")
   ```
   Kalau diminta ada label di bawah QR, tambahkan dengan PIL (ImageDraw, font bawaan) sebelum disimpan.
3. Jawab satu kalimat: QR untuk apa, tanpa menulis ulang isinya (kecuali link pendek). Jangan tulis password WiFi di teks.
