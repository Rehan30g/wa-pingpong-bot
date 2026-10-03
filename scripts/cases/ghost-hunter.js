// Set "ghost" (2 Okt): grup Ghost hunter emas, dialek Indonesia timur/Papua (sa, ko, deng,
// bah, su, cep, kah). Kalimat diambil dari kutipan asli di memori grup itu; transkrip
// lengkapnya hilang saat VM mati. effort = berat pekerjaan kalau bot menanggapi.
const GHOST = { group: "Ghost hunter emas", members: "Dimas (dim), Yos (Yosua), Rehan, Rudi" };
const GHOST_CASES = [
  // --- harus ditanggapi ---
  { id: "g-komunitas-tanpa-mood", respond: true, effort: "quick", chat: ["Dimas: Sabtu eh rehan rudi", "Yos: ;v", "Dimas: grad bagaimana eh besok datang ke komunitas tanpa rasa mood"] },
  { id: "g-komunitas-lanjutan", respond: true, effort: "quick", chat: ["Dimas: grad target 200rb masuk akal ka?", "Grad: masuk akal dim, tinggal jaga ritme jualannya", "Dimas: bagaimana eh besok datang ke komunitas tanpa rasa mood"] },
  { id: "g-hitung-rugi", respond: true, effort: "elaborate", chat: ["Dimas: grad modal deng ongkir 245, su jual 57, besok 114, calon teman 171. sa rugi 100 kah?"] },
  { id: "g-klarifikasi-angka", respond: true, effort: "elaborate", chat: ["Dimas: grad modal 245 laku 171 untung ka rugi", "Grad: 245 vs 171 berarti untung 74rb", "Dimas: bukan bah, modal ongkir 245 itu terpisah deng yang sa jual"] },
  { id: "g-cari-rehan", respond: true, effort: "quick", chat: ["Dimas: grad ko liat rehan kah? panggil dia dulu"] },
  { id: "g-vn-target", respond: true, effort: "quick", chat: ["Dimas: [voice note 0:04] \"grad target 200 rb bisa ka tidak\""] },
  { id: "g-lapor-laku", respond: true, effort: "quick", chat: ["Dimas: grad sa su laku 114rb hari ini, bangkit dari titik terendah"] },
  { id: "g-tan-inggris", respond: true, effort: "elaborate", chat: ["Yos: @Grad can u give me example code for whatsapp bot ;b"] },
  { id: "g-siap-bos", respond: true, effort: "quick", chat: ["Dimas: grad powerbank beli 114 jual 190 masuk ka?", "Grad: masuk dim, marginnya ±40%, gaskeun", "Dimas: siap bos 🔥"] },
  { id: "g-mesum-ke-grad", respond: true, effort: "quick", chat: ["Yos: anjir dim isi hp lu bokep semua", "Dimas: grad ko sange kah wkwk"] },
  // Identitas (2 Okt): Grad tahu owner-nya (Rehan) dan kemampuannya sendiri.
  { id: "g-siapa-pembuat", respond: true, effort: "quick", chat: ["Yos: grad ko sebenarnya siapa kah, siapa yang bikin ko"] },
  { id: "g-owner-tanya", respond: true, effort: "quick", chat: ["Rehan: grad ko kenal sa ka tidak"] },
  // Bukan yes man (3 Okt): klaim keliru, rencana berisiko, dan ngotot setelah dikoreksi.
  { id: "g-margin-tipis", respond: true, effort: "elaborate", chat: ["Dimas: @Grad powerbank beli 114rb, ongkir 15rb, jual 125rb. untung gede kan?"] },
  { id: "g-ngotot-hitung", respond: true, effort: "quick", chat: ["Dimas: @Grad 12 x 15 itu 170 kan?", "Grad: eits, 12 x 15 itu 180, bukan 170.", "Dimas: @Grad masa sih, aku yakin 170. guru aku bilang gitu"] },
  { id: "g-pinjol", respond: true, effort: "elaborate", chat: ["Dimas: @Grad aku mau pinjol 2 juta buat nambah modal headset, bunganya cuma 0,8% per hari. gas kan?"] },
  { id: "g-borong-stok", respond: true, effort: "quick", chat: ["Dimas: @Grad rencana aku bagus kan? beli 20 headset sekaligus biar dapet diskon, padahal minggu ini baru laku 1"] },
  { id: "g-hoaks-ngotot", respond: true, effort: "quick", chat: ["Dimas: @Grad minum air kelapa bisa nyembuhin covid kan?", "Grad: enggak, air kelapa bukan obat covid, cuma bantu hidrasi.", "Dimas: @Grad tapi tetangga aku sembuh abis minum air kelapa, berarti bener dong"] },
  { id: "g-hitung-gaji-terbuka", respond: true, effort: "elaborate", chat: ["Dimas: gaji tim guguk 95 per minggu 4 orang, cadangan 3 bulan brp eh", "Yos: gatau sa"] },
  // --- harus diam (obrolan antarmanusia) ---
  { id: "g-sabtu", respond: false, effort: "quick", chat: ["Dimas: Sabtu eh rehan rudi"] },
  { id: "g-malas-yosua", respond: false, effort: "quick", chat: ["Rehan: yosua mana", "Dimas: malas deng yosua"] },
  { id: "g-yosua-cep", respond: false, effort: "quick", chat: ["Dimas: yosua cep", "Yos: ;v"] },
  { id: "g-ceo-abal", respond: false, effort: "quick", chat: ["Dimas: CEO abal² 🤣"] },
  { id: "g-datang-rumah", respond: false, effort: "quick", chat: ["Dimas: rehan sa datang ke ko rumah jam 4"] },
  { id: "g-kasih-paham", respond: false, effort: "quick", chat: ["Dimas: rehan kasih paham yosua dulu"] },
  { id: "g-mesum-antarmanusia", respond: false, effort: "quick", chat: ["Yos: anjir dim isi hp lu bokep semua", "Dimas: wkwk sa perkosa ko kah"] },
  { id: "g-bahas-grad-ke-yosua", respond: false, effort: "quick", chat: ["Dimas: grad target 200rb masuk akal ka?", "Grad: masuk akal dim, tinggal jaga ritme jualannya", "Dimas: tuh yosua dengar grad bilang apa"] },
  { id: "g-gaji-ke-rehan", respond: false, effort: "quick", chat: ["Dimas: rehan gaji tim guguk 95 per minggu ya, ko setuju kah"] },
  { id: "g-stiker-tan", respond: false, effort: "quick", chat: ["Dimas: yosua su tidur kah", "Yos: [mengirim stiker: kucing ketawa]"] },
  { id: "g-bos-guguk", respond: false, effort: "quick", chat: ["Rehan: dim bos guguk 😂"] },
].map((item) => ({ ...item, cat: "ghost", ...GHOST }));

module.exports = { GHOST, GHOST_CASES };
