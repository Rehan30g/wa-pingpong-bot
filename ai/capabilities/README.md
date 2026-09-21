# Capability workspace

Folder ini disiapkan untuk tool agen yang melakukan I/O nyata. Registry belum
mengeksekusi apa pun dan semua capability harus nonaktif secara default.

Rencana capability:

- `fetch-media` — mengambil media dari URL atau pesan WhatsApp.
- `send-media` — mengirim gambar, video, dan file kepada chat yang berwenang.
- `make-sticker` — mengubah gambar menjadi stiker WhatsApp.
- `workspace-files` — penyimpanan file/catatan milik AI dengan sandbox sendiri.
- `python-runner` — menjalankan Python dalam sandbox dengan batas resource.

Kontrak, tahapan, dan gate keamanan lengkap ada di `Plan.md` pada root proyek.
