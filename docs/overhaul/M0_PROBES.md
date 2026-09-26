# M0 · Hasil probe OpenRouter (26 Sep 2026)

Dijalankan dari mesin dev (koneksi langsung, `PROBE_NO_PROXY=1`). Di VPS jalankan tanpa flag itu supaya lewat proxy 8118. API key tidak dicetak oleh skrip.

## 1. GLM + native tool calling + `openrouter:web_search`

Skrip: `npm run probe:tools -- 3` (`scripts/probe-openrouter-tools.js`)

Request: `z-ai/glm-5.3-flash`, `reasoning.effort=low`, `tools = [openrouter:web_search (max_results 5), get_wit_time (function)]`, `tool_choice=auto`. Pertanyaan: "hari ini tanggal berapa, dan harga iPhone 17 di Indonesia sekarang kisaran berapa? sebutin sumbernya".

| Percobaan | Hasil | Langkah | Total | Citation | Biaya |
|---|---|---|---|---|---|
| 1 | ✅ | 2 (function call → jawaban) | 12,0 s | 5 | $0,0075 |
| 2 | ✅ | 2 | 10,3 s | 5 | $0,0076 |
| 3 | ✅ | 2 | 7,0 s | 5 | $0,0075 |

Temuan:
- **Stabil 3/3.** Server tool web search dan function tool jalan di request yang sama. Pada langkah pertama GLM sudah mencari di web (5 `url_citation` di `annotations`) *dan* memanggil `get_wit_time`. Setelah hasil function dikembalikan, jawaban final keluar di langkah kedua.
- Tool call berformat OpenAI standar (`tool_calls[].function.name/arguments`), jadi `glm-client.js` bisa dipakai apa adanya. **Fallback action envelope Ajv tidak diperlukan.**
- Sumber relevan dan lokal (kompas, detik, ibox, digimap, apple.com).
- Biaya ±$0,0075 per tugas, hampir seluruhnya dari web search (5 hasil). Token GLM sendiri murah (~4k prompt, ~300 completion). Budget harian M1 sebaiknya dihitung per pencarian, bukan per token.
- `usage.server_tool_use` kosong. Jumlah pencarian harus dihitung dari `annotations`/biaya, bukan dari field itu.
- Field `provider` di respons bernilai `OpenAI` walau model GLM. Tidak berdampak, cukup dicatat.
- **Perlu ditangani di M1:** jawaban memakai markdown (`**tebal**`, `[judul](url)`) dan daftar panjang. Prompt loop harus meminta format WhatsApp (`*tebal*`, URL polos, ringkas), plus sanitasi format di kode sebelum kirim.

## 2. Gemini Flash sebagai "telinga"

Skrip: `npm run probe:audio -- <file> ["pertanyaan"]` (`scripts/probe-audio.js`)

Alur: file → ffmpeg `mp3 16 kHz mono 32 kbps` (dipotong `AI_MAX_AUDIO_SEC`) → `google/gemini-3.8-flash` dengan `input_audio` + `response_format: json_schema` (transcript, language, speech, non_speech, tone, summary, confidence).

Sampel: voice note sintetis 8,5 detik (ogg/opus seperti WA, dibuat dengan TTS) berisi *"Grad, eh besok rapat jadinya jam berapa sih? Gue lupa anjir. Terus si Budi jadi bawa proyektor nggak? Kabarin ya, thanks bro."*

| Mode | Hasil | ffmpeg | Gemini | Biaya |
|---|---|---|---|---|
| Transkrip #1 | Kata demi kata benar (slang "anjir", "gua", "thanks bro" dipertahankan), `tone: santai`, `confidence 0.98` | 74 ms | 6,5 s | $0,0008 |
| Transkrip #2 | Sama persis | 60 ms | 4,8 s | $0,0008 |
| `listen_audio` ("marah/panik/santai? sebut nama & waktu") | "Santai … nama: Grad, Budi … waktu: besok" | 56 ms | 3,0 s | $0,0004 |
| Musik 20 s (lagu rohani, transkrip) | `non_speech: [choir, music, singing]`, lirik ditranskrip benar | 87 ms | 5,5 s | $0,0010 |
| Musik, "ini lagu apa?" | Menebak judul dari lirik dengan yakin, tetapi **judulnya tidak cocok** dengan judul file | 84 ms | 3,4 s | $0,0006 |

Temuan:
- Structured output berjalan. Transkrip Indonesia + slang akurat dan ejaan nama dari konteks terbaca benar.
- Latensi 3–6,5 detik per voice note pendek. Presence `recording`/`composing` perlu dinyalakan selama transkripsi di M1.
- Biaya < $0,001 per voice note pendek.
- **Identifikasi lagu tidak bisa dipercaya.** Gemini menebak judul dengan yakin. Di M1, jawaban `listen_audio` untuk "lagu apa" harus diperlakukan sebagai tebakan: GLM sebaiknya memverifikasi potongan lirik lewat `web_search` sebelum menyebut judul.
- **Belum diuji:** voice note manusia asli (logat, bising, ngomong cepat). Ini perlu satu voice note nyata dari grup sebelum M1 dinyatakan selesai.

## 3. Pemilihan model audio (lanjutan, 26 Sep 2026)

`gemini-3.8-flash` mewajibkan thinking (tidak bisa dimatikan) dan relatif mahal. Model lain dibandingkan lewat `ears.transcribe` yang sebenarnya (konteks nama bot + json_schema). Sampel: voice note sintetis 8 detik + klip musik 20 detik; waktu = median 3 percobaan; biaya dari `usage.cost`.

| Model | Thinking | VN | Biaya/VN | Nama "Grad" | Musik | "Ini lagu apa?" |
|---|---|---|---|---|---|---|
| gemini-3.8-flash | wajib (minimal) | 4,4 s | $0,00087 | ✅ | ✅ | yakin |
| **gemini-3.1-flash-lite** (dipilih) | off | 2,2 s | $0,00037 | ✅ 8/8 | ✅ (lirik sebagian) | yakin |
| gemini-3.1-flash-lite-preview | off | 1,8 s | $0,00032 | ✅ 8/8 | ✅ | kutip lirik |
| gemini-3.5-flash-lite | wajib (minimal) | 2,1 s | $0,00048 | ❌ "Grat" | ❌ tanpa ucapan | tebakan |
| xiaomi/mimo-v2.6-flash (cadangan) | off | 4,2 s | $0,00008 | ✅ | ✅ (9 s) | tebakan salah |
| meta/muse-spark-1.3-contributor | minimal | 6,0 s | $0,00007 | ✅ | ✅ | tebakan |
| xiaomi/mimo-v2.6-pro | off | 7,4 s | $0,00018 | ✅ | ❌ tanpa ucapan | ❌ |

Keputusan: `gemini-3.1-flash-lite` (stabil, bukan preview) dengan thinking off, cadangan `mimo-v2.6-flash`. Prompt telinga kini meminta nama yang terdengar mirip nama bot ("Grat", "Gred") ditulis persis sebagai nama bot, supaya mention di voice note tetap terbaca. Pencocokan nama longgar di kode sengaja tidak dipakai (risiko "Grab"/"gratis" terbaca mention).
