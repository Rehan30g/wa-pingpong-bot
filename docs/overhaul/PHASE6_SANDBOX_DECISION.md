# Fase 6 — Python sandbox opsional

Keputusan: **tidak mengaktifkan `run_python`**. Fase ini opsional menurut `Plan.md`; runtime utama Jev + GLM tidak bergantung padanya.

Alasannya konkret: proses Python biasa, blacklist kode, atau child process yang hanya dibatasi timeout tidak memenuhi kontrak isolasi. Belum ada image container yang dipin dan diuji pada VPS target untuk non-root, tanpa jaringan, tanpa secret/host mount/Docker socket, filesystem read-only kecuali direktori job, serta batas CPU/RAM/PID/disk/output/waktu. Menambahkan tool setengah aman akan memperluas permukaan akses bot sebelum gate tersebut tersedia.

Gate sebelum fitur ini boleh dibuka: image dan digest tetap; uji isolasi file host, jaringan, env secret, device/socket, fork bomb, CPU/RAM/disk/output besar, timeout dan cancellation; verifikasi artefak dalam asset store privat; audit bahwa tool tetap nonaktif saat infrastruktur sandbox absen. Sampai saat itu, registry tidak mendaftarkan capability `run_python`, router tidak punya intent untuknya, dan `.env.example` tidak menawarkan flag untuk menyalakannya.

Status Fase 6: **ditutup sebagai capability opsional yang sengaja tidak disertakan**, bukan klaim bahwa Python sandbox sudah diimplementasikan atau lulus uji.
