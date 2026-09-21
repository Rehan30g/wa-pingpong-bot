# Plan: Media, Storage, dan Python Capabilities

## Tujuan

Menambahkan tool nyata untuk Grad tanpa memberi model akses bebas ke filesystem,
shell, jaringan, atau penerima WhatsApp. Jev tetap memilih apakah bot perlu
bertindak; GLM memilih tool dan argumen melalui schema terstruktur; executor
lokal memvalidasi izin sebelum menjalankan tindakan.

## Fondasi yang sudah disiapkan

- `ai/capabilities/registry.js`: registry eksplisit, nonaktif secara default.
- Riwayat pesan memiliki `entry_id` dan referensi pesan sehingga tool dapat
  menunjuk pesan/media tertentu tanpa menebak “pesan terakhir”.
- Media mempunyai `type`, `kind` (`sticker`/`attachment`), dan `format`.
- Identitas penerima harus PN terverifikasi; LID mentah tidak boleh menjadi
  target pengiriman atau whitelist.

## Kontrak capability

Setiap capability wajib memiliki:

1. Nama dan JSON schema input/output.
2. Scope eksplisit: grup/DM, pembaca/penulis, dan target yang diizinkan.
3. Validator deterministik di luar model.
4. Timeout, batas ukuran, kuota, dan audit log WIT.
5. Idempotency key untuk tindakan kirim/tulis.
6. Mode dry-run dan error yang aman untuk ditampilkan.
7. Tes langsung dengan mock socket/executor, termasuk penolakan akses.

## Tahap 1 — Fetch image dari URL/chat

- Tool `fetch_media_from_url(url)` hanya menerima `https`.
- Tolak localhost, private IP, redirect ke private IP, kredensial URL, dan tipe
  MIME di luar allowlist untuk mencegah SSRF.
- Terapkan batas byte streaming, timeout, jumlah redirect, dan verifikasi MIME
  dari isi file, bukan hanya header.
- Tool `fetch_media_from_message(entry_id)` hanya boleh membaca media dari
  riwayat chat aktif yang sama.
- Simpan hasil sebagai asset ID; jangan memasukkan path host ke prompt.

Gate selesai: tes SSRF, redirect, oversized stream, MIME palsu, dan entry dari
chat lain seluruhnya ditolak.

## Tahap 2 — Kirim gambar/video/file

- Tool `send_asset(asset_id, destination, caption, mode)`.
- Destination default dan satu-satunya tanpa otorisasi tambahan adalah chat
  aktif. Target lain memerlukan policy owner yang eksplisit.
- Cek whitelist DM, opt-out, ukuran WhatsApp, MIME, dan existence asset.
- Satu tool call hanya boleh mengirim ke satu chat; tidak ada wildcard/list
  penerima untuk mencegah broadcast.
- Gunakan idempotency key agar retry tidak mengirim duplikat.

Gate selesai: tidak ada jalur yang dapat mengirim ke nomor arbitrer atau banyak
penerima sekaligus.

## Tahap 3 — Kirim gambar sebagai stiker

- Tool `make_sticker(asset_id, metadata)` menghasilkan WebP pada workspace.
- Normalisasi dimensi, ukuran, durasi animasi, EXIF pack/author, dan transparansi.
- Tool hanya menghasilkan asset baru; pengiriman tetap lewat `send_asset`.

Gate selesai: gambar statis dan animasi valid di WhatsApp, input rusak gagal
tanpa crash atau file sementara tertinggal.

## Tahap 4 — Storage file dan notes milik AI

- Root khusus, misalnya `./agent-workspace/`; semua path di-resolve lalu wajib
  tetap berada di bawah root tersebut.
- Operasi: list, read, create, edit, rename, move, mkdir, dan delete-to-trash.
- Gunakan asset/note ID di prompt; path absolut tidak pernah diberikan ke model.
- Nama file disanitasi; symlink, traversal `..`, device file, executable, dan
  overwrite diam-diam ditolak.
- Delete default masuk `.trash`; purge hanya owner dan memerlukan command khusus.
- Audit log append-only mencatat actor, chat, operasi, target, dan waktu WIT.

Gate selesai: traversal/symlink escape, overwrite, cross-chat access, dan delete
permanen tanpa otorisasi tidak mungkin dilakukan.

## Tahap 5 — Python

- Tool `run_python(code, input_asset_ids)` berjalan pada proses/container
  terisolasi, bukan shell bot utama.
- Tanpa network secara default, filesystem read-only kecuali direktori job,
  environment disaring, stdin ditutup, dan subprocess/native extension dibatasi.
- Batas wajib: wall time, CPU, RAM, output, jumlah file, dan total byte.
- Hasil hanya berupa stdout ringkas serta asset ID dari direktori output.
- Paket menggunakan allowlist image/data-processing; instal paket runtime dan
  akses token/API dilarang.

Gate selesai: tes timeout, fork bomb, pembacaan `.env`/`auth`, network, path
escape, output bomb, dan proses anak semuanya terblokir.

## Urutan implementasi

1. Asset store + policy/audit primitives.
2. Fetch media chat dan URL.
3. Send media/file satu-chat.
4. Sticker pipeline.
5. Workspace notes/files.
6. Python sandbox terakhir, setelah semua gate sebelumnya stabil.

## Definition of done

- Semua tool memakai schema ketat dan executor deterministik.
- Tidak ada API generik `sendMessage(target)` yang terekspos ke model.
- Tidak ada path host, API key, auth WhatsApp, atau proxy credential di prompt.
- Unit test, integration test mock socket, recovery/retry, dan audit log lulus.
- Fitur dinyalakan per capability oleh owner setelah dry-run tervalidasi.
