# Log Update Grad

## 2 Oktober 2026 — branch `grad-identitas-gabungan-model`

### Baru
- **Grad kenal dirinya dan owner-nya.** Owner dikenali dari nomor terverifikasi (bukan nama atau pengakuan), pesannya bertanda "(owner)" di riwayat, dan di DM Grad tahu sedang ngobrol dengan owner. Grad juga tahu kemampuannya sendiri sesuai fitur aktif, jadi tidak lagi menjawab "aku cuma bot". Diminta memanggil orang → Grad men-tag @Nama sungguhan.
- **Gabungan dua model.** Obrolan dijawab DeepSeek V4.1 Flash (lebih paham dialek timur, lebih natural); tugas dan langkah setelah tool dikerjakan GLM 5.3 Flash (lebih tertib memakai tool). Jev menilai berat pekerjaan (singkat/berbelit) di panggilan keputusan yang sama, tanpa menambah latensi. Matikan: `CHAT_MODEL_FAST=off`.
- **Provider OpenRouter dipilih otomatis** dari statistik live (latensi, throughput, uptime, harga) per model, dimuat ulang tiap 15 menit. Provider yang kena rate limit (429) diturunkan sementara. Obrolan turun dari ±5,7 dtk jadi ±1–2 dtk.
- **Rem obrolan tidak senonoh.** Grad tidak ikut bercanda mesum: reaction/stiker tawa dan nimbrung ditahan, Grad menegur halus sesekali, dan kalau terus didesak Grad diam.
- **Tool `stay_silent`**: lapisan kedua setelah Jev. GLM boleh memilih tidak menjawab pesan yang tidak pantas; tidak ada apa pun yang terkirim.
- **Bot nyala sendiri setelah VM reboot** (`scripts/tmux-sessions.sh` lewat crontab `@reboot`), log tersimpan di `data/logs/wabot.log`.
- **Alat uji baru:** `npm run bench:providers`, `npm run bench:decision -- --set ghost` (plus model `liquid/d1`), `npm run simulate:ghost`, `npm run simulate:decency`.

### Diperbaiki
- Ack ("sip", "makasih", "siap bos") dulu bisa >20 dtk dan didahului "sebentar, lagi kukerjain". Sekarang selesai satu langkah (±1–2 dtk) tanpa pesan progres.
- Grad dulu diam selamanya kalau loop error setelah mengirim "bentar ya". Sekarang memberi kabar singkat, di grup maupun DM.
- Web search OpenRouter yang error (502) dulu diulang 3× dengan isi yang sama (±65 dtk); sekarang langsung dicoba ulang tanpa web search. `OPENROUTER_MAX_RETRIES=0` dulu terbaca 2.
- Hitungan uang (untung/rugi, modal, patungan) wajib lewat `run_python`; kasus "untung 97rb" yang dijawab "rugi" tidak terulang. Satuan dipertahankan ("4,94 jt", bukan "Rp4.940").
- Python sandbox bisa akses internet lagi di Node 22 (flag JSPI), jadi skill cuaca, kurs, dan jadwal sholat jalan lagi.
- `media_edit` bisa menambah teks lagi (ffmpeg dengan `drawtext`); kalau filternya tidak ada, Grad memberi pesan jelas.
- Pesan mesum lanjutan tidak lagi dihitung "lanjutan dialog bot", supaya Grad tidak menegur berulang kali.
- Memori ringkasan: "belum selesai" maksimal 5 butir, tanpa kutipan kasar.

## 27 September – 1 Oktober 2026 (ikut di commit yang sama)
- **Persona Grad:** playful dan hangat, aku–kamu, roasting hanya dengan pemicu, zona serius untuk duka/kesehatan/curhat. Rem humor otomatis supaya Grad tidak meniru ekspresinya sendiri (kasus 😑).
- **Bubble:** obrolan santai boleh dipecah sampai 3 bubble.
- **Nimbrung jarang:** maksimal 1×/jam dan hanya saat grup ramai.
- **Tag orang** dengan @Nama di grup (maks 3, tanpa @semua).
- **DM ⇄ grup:** di DM Grad tahu obrolan grup yang sama-sama diikuti; fakta DM yang aman (bukan kesehatan, keuangan, asmara, dll.) bisa dipakai di grup.
- **Titip pesan DM → grup** (`tell_group`), dengan konfirmasi untuk tag/tagih/tegur.
- **Multitasking:** selama mengerjakan tugas seseorang, Grad tetap menanggapi member lain di jalur samping.
- **Pembagian kerja Jev vs GLM:** untuk pesan yang ditujukan ke Grad, Jev hanya memutuskan diam atau tidak; bentuk tanggapan (teks, stiker, reaction) dipilih GLM.
- **Mata gerak:** stiker animasi dan GIF ditonton sebagai video diperlambat 4×.
- **`watch_video`:** Grad bisa menonton isi video (transkrip ucapan, kejadian, tulisan).
- **Zip berpassword** (AES-256) lewat skill `zip_berpassword`.
- File hasil `run_python` (.txt/.md/.json/.zip) ikut terkirim sebagai dokumen.
- Penerima yang gagal dekripsi bisa minta kirim ulang (pesan tidak lagi tertahan "Menunggu pesan ini"), dan DM lewat LID tidak lagi bentrok sesi.
- Benchmark model keputusan (`npm run bench:decision`).
