# Laporan Status Overhaul AI Agent Grad

**Snapshot: 23 September 2026 · proyek lokal `D:\EXPERIMENT\A`**

> **Intinya:** Grad sedang naik kelas dari bot WhatsApp yang terutama membalas chat menjadi agen yang dapat menerima tugas, merencanakan langkah, memakai alat yang dibatasi, menyimpan progres, lalu memeriksa bukti hasil. Fondasi agen sudah berjalan dalam tes lokal. Overhaul **belum selesai dan belum diluncurkan ke produksi**. Pengujian langsung di WhatsApp menjadi tanggung jawab pengguna; pengembangan, tes lokal, dan simulasi tanpa pengiriman WhatsApp nyata menjadi tanggung jawab pengembang.

## Cara membaca status

| Label | Artinya bagi pengguna |
|---|---|
| **Ada di bot lama** | Fitur percakapan yang sudah menjadi bagian dari alur bot yang ada. |
| **Lulus lokal** | Kode dan tes/simulasi lokal sudah membuktikan perilaku tertentu; belum berarti aktif di WhatsApp produksi. |
| **Siap diuji terbatas** | Implementasi tersedia, tetapi sengaja dimatikan sampai gate keamanan dan uji lapangan lulus. |
| **Dalam pengerjaan** | Masih ada kontrak atau tes penting yang belum terpenuhi. |
| **Belum dimulai / opsional** | Masih berupa rencana; jangan diasumsikan tersedia. |

## Peta fase

| Fase | Status | Penjelasan awam | Bukti atau syarat berikutnya |
|---|---|---|---|
| **0. Baseline** | **Selesai** | Mencatat kemampuan dan risiko bot sebelum perombakan. | Audit model, API, tes awal, dan perlindungan data terdokumentasi. |
| **1. Fondasi** | **Lulus lokal** | Membuat aturan izin, format jawaban mesin, batas biaya, dan pencatatan yang aman. | Laporan fondasi dan tes negatif tersedia. |
| **2. Mesin tahan restart** | **Lulus lokal** | Tugas dan pengiriman dicatat agar tidak lenyap diam-diam saat proses berhenti. | Tes SQLite, lease, recovery, outbox, pembatalan, dan shadow tersedia. |
| **3. Loop agen MVP** | **Lulus lokal dengan batas** | Grad dapat menyusun dan menjalankan beberapa langkah, lalu mengecek hasilnya. | Tugas tiga langkah dan replan terbatas untuk note yang tidak ditemukan telah diuji. Replan umum belum ada. |
| **4. Media dan web** | **Gate lokal otomatis selesai** | Grad dapat membaca sumber web, mengelola gambar, dan membuat stiker sebagai tugas dalam tes lokal. | 212 tes lulus; uji WhatsApp langsung milik pengguna dan belum dinilai. Fitur tetap mati default. |
| **5. Memori dan proaktif** | **Gate lokal otomatis selesai** | Fakta punya sumber, masa berlaku, scope chat, konflik berkunci, dan koreksi eksplisit; check-in perlu persetujuan. | 220 tes lokal lulus; simulasi OpenRouter lulus. Flag facts tetap mati default, belum uji WA/canary. |
| **6. Python terisolasi** | **Opsional, sengaja tidak disertakan** | Bot belum menjalankan kode Python dari pengguna. | Sandbox aman di VPS belum tersedia/teruji; keputusan tercatat di `PHASE6_SANDBOX_DECISION.md`. |
| **7. Evaluasi dan rilis** | **Gate lokal selesai; rilis tertahan** | 60 skenario lokal dan simulasi API 3 kali sudah lulus, tetapi bot baru belum dipakai orang sungguhan. | Shadow ≥24 jam, canary ≥48 jam dan ≥30 tugas, review naturalness, restore staging lengkap, dan izin rollout masih diperlukan. |

## Fitur yang sudah ada atau sudah terbukti secara lokal

| Fitur | Untuk pengguna awam | Untuk power user | Status nyata |
|---|---|---|---|
| **Jev memilih kapan merespons; GLM Flash menulis jawaban** | Bot tidak asal nimbrung di setiap chat. | Keputusan Jev terpisah dari generasi GLM; GLM memakai reasoning rendah dan output terstruktur. | **Ada di bot lama**; simulasi OpenRouter nyata pernah lulus. |
| **Obrolan grup lebih natural** | Bisa diam, bereaksi, membalas singkat, atau mengutip pesan yang relevan. | Debounce, penanganan pesan bertubi-tubi, `reply_to_entry_id`, klasifikasi media, dan read receipt setelah evaluasi. | **Ada di bot lama**, dijaga oleh tes regresi. |
| **DM dengan pagar keamanan** | Orang yang tidak dikenal dari grup yang diizinkan tidak otomatis dilayani; permintaan broadcast ditolak. | Whitelist berbasis nomor peserta, opt-out, tanpa API kirim ke penerima arbitrer. | **Ada di bot lama**, diuji dengan mock socket dan simulasi API. |
| **Pengingat dan check-in** | Bisa mengingatkan pengguna; check-in otomatis dibatasi agar tidak mengganggu. | Jadwal, jam tenang WIT, cooldown, kuota harian, whitelist, opt-out. Reminder eksplisit tetap berjalan saat proaktif dimatikan. | **Ada di bot lama**; penyatuan aturan proaktif baru masuk Fase 5. |
| **Memori grup, orang, dan DM** | Bot dapat mengingat konteks tanpa menyimpan semua chat aktif selamanya. | Memori v2 JSON, compact GLM/Jev, `/clear`, `/reset`, `/memory`. | **Ada di bot lama**; provenance, TTL, dan retrieval ber-ACL belum tuntas. |
| **Tugas beberapa langkah** | Contoh: buat catatan, baca lagi, lalu ringkas dengan hasil yang dicek. | Planner JSON schema, capability registry, checkpoint SQLite, budget, verifier, replan khusus note tidak ditemukan. | **Lulus lokal**; engine produksi masih `legacy`. |
| **Demo headless lokal** | Coba `/task` di terminal tanpa menghubungkan WhatsApp. | `npm run agent:headless`; GLM nyata, SQLite sementara, mode shadow, tanpa send. | **Berjalan lokal**; tidak mengaktifkan bot WA. |
| **Tahan crash dan pengiriman tidak pasti** | Bila bot mati di tengah tugas, statusnya dipulihkan; bot tidak pura-pura yakin pesan sudah terkirim. | Lease/fencing, inbox dedupe, outbox, context epoch, `delivery_uncertain`, rekonsiliasi tanpa blind resend. | **Lulus lokal** dengan simulasi fault injection. |
| **Video sebagai satu frame** | Video dapat diwakili satu gambar agar GLM melihat cuplikan; bot tidak mengaku telah menonton seluruh video. | ffmpeg mengekstrak frame JPEG dengan batas waktu/ukuran; gagal secara lunak ke metadata. | **Lulus lokal**; belum bukti menyeluruh di WhatsApp nyata. |
| **Cari web dengan sumber** | `/task cari web <topik>` dirancang memberi jawaban dengan tautan sumber. | OpenRouter server tool Exa, satu pencarian/tugas, maks. tiga hasil, query sensitif ditolak, sitasi diwajibkan. | **Siap diuji terbatas**, flag mati default; probe API nyata berhasil 1 pencarian/3 sitasi. |
| **Baca halaman atau ambil gambar dari URL** | Bisa membaca halaman tertentu atau mengambil gambar yang diminta. | HTTPS + host allowlist, DNS/IP privat ditolak, koneksi dipin, redirect/byte/encoding/timeout dibatasi. | **Siap diuji terbatas**, flag mati default. |
| **Media pesan → stiker → kirim ke chat asal** | Foto yang dikirim/di-reply bisa menjadi stiker 512×512. | Asset privat per chat/tugas, SHA-256, TTL, konversi proses anak, outbox dan verifikasi receipt. | **Siap diuji terbatas** dengan mock socket; belum klaim sukses pada WhatsApp nyata. |
| **Mode shadow dan canary** | Bot baru bisa diuji tanpa langsung mengirim pesan ke orang. | DB/asset shadow terpisah; efek eksternal di mode agent memerlukan canary allowlist. | **Mekanik lulus lokal**; soak 24 jam dan canary produksi belum dijalankan. |

## Upcoming: apa yang masih harus dibereskan

| Prioritas | Pekerjaan | Dampaknya bagi pengguna | Batas selesai |
|---|---|---|---|
| **Tinggi** | Uji WhatsApp langsung oleh pengguna saat siap untuk canary. | Memastikan perilaku media dan stiker pada transport asli. | Hasil uji WA dicatat terpisah; gate lokal SSRF, ACL, limit, dan mock delivery telah lulus. |
| **Selesai lokal** | Memori dengan sumber, izin baca, masa berlaku, koreksi, dan migrasi konservatif dari memori v2. | Bot tahu *dari mana* ia tahu sesuatu dan tidak membocorkan isi DM ke grup lain. | Tes lintas scope, `/clear`/`/reset`, expiry, dan konflik berkunci lulus; belum canary. |
| **Tinggi** | Perbaiki kontrol proaktif dan izin berkelanjutan, termasuk pause darurat yang terpisah dari off. | Bot tidak menghubungi orang pada waktu atau konteks yang salah. | Opt-out, jam tenang, cooldown, whitelist, human takeover, dan reminder diuji. |
| **Selesai lokal** | Evaluasi 60 skenario unik dengan kasus serangan, crash, dan tool. | Klaim lokal didasarkan pada suite nyata, bukan demo tunggal. | 60/60 lulus dengan mock/fault injection; tugas WA nyata dan kualitas manusia tetap di gate rilis. |
| **Tinggi** | Shadow 24 jam, canary 48 jam/30 tugas, restore dan rollback drill. | Risiko saat mengaktifkan bot baru diturunkan bertahap. | Observasi nyata, metrik, dan izin rollout terpenuhi. |
| **Opsional** | `run_python` di sandbox container. | Kelak bisa mengolah data/kode untuk tugas tertentu. | Tetap nonaktif jika isolasi OS, resource, dan kerahasiaan belum terbukti. |

## Bukti saat snapshot ini

| Pemeriksaan | Hasil | Makna yang tepat |
|---|---|---|
| `npm test` | **222/222 lulus** pada run lokal terbaru, termasuk demo headless | Regresi lokal hijau; bukan bukti lulus canary produksi. |
| Simulasi OpenRouter grup/DM | **13/13 grup**, **5/5 DM** pada run yang dilaporkan | Jev/GLM merespons skenario tes tanpa mengirim WhatsApp nyata. |
| Probe web search OpenRouter | **1 pencarian, 3 sitasi** | API nyata mendukung jalur pencarian; flag produksi masih mati. |
| `npm audit --omit=dev` | **0 vulnerability** pada pemeriksaan terakhir yang dilaporkan | Kondisi dependensi saat pemeriksaan, bukan jaminan keamanan total. |
| Engine default | **`legacy`** | Fitur agen baru tidak otomatis mengambil alih bot produksi. |
| Rilis produksi | **Belum dilakukan** | Belum ada klaim shadow 24 jam, canary 48 jam, atau persetujuan deploy. |

## Seberapa besar perombakan ini?

Ini **bukan sekadar mengganti prompt**. Sebelumnya Grad terutama memutuskan apakah akan membalas lalu menulis pesan. Desain barunya menambah alur kerja lengkap:

```text
Permintaan → cek identitas & izin → rencana GLM → alat terbatas
          → simpan checkpoint → verifikasi bukti → kirim/status jujur
```

Bagi pengguna awam, tujuannya sederhana: **minta hasil, bukan cuma jawaban**. Grad kelak bisa membaca catatan, mencari sumber, mengolah foto menjadi stiker, dan melanjutkan tugas setelah restart, sambil tetap tahu kapan harus diam. Bagi power user, nilai besarnya ada pada batas yang dapat diaudit: scope per chat, izin sebelum efek samping, budget, idempotensi, recovery, dan laporan ketidakpastian pengiriman.

**Ajakan:** jika gate berikutnya lulus, coba beri Grad tugas kecil yang bisa diperiksa hasilnya—misalnya membaca satu catatan, merangkum sumber web, atau membuat stiker dari foto sendiri. Uji coba dimulai di shadow/canary yang terbatas. Klaim “agen otonom siap penuh” baru layak dipakai setelah Fase 4, 5, dan 7 benar-benar lolos.

Rincian teknis dan batas yang lebih ketat ada di [`Plan.md`](../../Plan.md), [`PHASE3_AUTONOMOUS_LOOP_REPORT.md`](./PHASE3_AUTONOMOUS_LOOP_REPORT.md), dan [`PHASE4_MEDIA_WEB_REPORT.md`](./PHASE4_MEDIA_WEB_REPORT.md).

**Pembagian uji:** pengembang tidak mengirim pesan WhatsApp nyata. Pengguna menjalankan uji langsung di WA setelah menerima skenario dan langkah pemeriksaan yang jelas. Hasil uji itu tetap diperlukan sebelum klaim fitur WA tertentu siap dipakai luas.
