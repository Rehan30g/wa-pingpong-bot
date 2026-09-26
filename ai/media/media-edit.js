// Edit media dengan FFmpeg untuk tool `media_edit` (Plan v2 lanjutan M4b).
// Model tidak pernah memberi argumen ffmpeg mentah: ia memilih operasi yang
// dikurasi (trim, speed, resize, crop, teks, mute, reverse, gabung) dan format
// keluaran; kode ini yang menyusun argumen. Hanya file lokal di folder kerja
// yang dibaca (protocol_whitelist=file), tanpa shell, dengan batas waktu/ukuran.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_INPUT_BYTES = 64 * 1_048_576;
const MAX_OUTPUT_BYTES = 16 * 1_048_576;
const MAX_DURATION_SEC = 600;
const STICKER_MAX_BYTES = 1_000_000;
const FONT_CANDIDATES = [
  process.env.MEDIA_FONT_FILE,
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
].filter(Boolean);

const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH || "ffprobe";

function run(bin, args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-20_000); });
    proc.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("ffmpeg_timeout")); }, timeoutMs);
    proc.on("error", (error) => { clearTimeout(timer); reject(error); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffmpeg gagal: ${stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}`));
    });
  });
}

async function probe(file, cwd) {
  const out = await run(ffprobeBin(), ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { cwd, timeoutMs: 20_000 });
  const data = JSON.parse(out);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === "video");
  return {
    duration: Number(data.format?.duration) || 0,
    hasVideo: Boolean(video),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    width: video?.width || 0,
    height: video?.height || 0,
  };
}

const TIME = /^(\d{1,2}:)?\d{1,2}:\d{1,2}(\.\d+)?$|^\d+(\.\d+)?$/;
function seconds(value) {
  const text = String(value ?? "").trim();
  if (!TIME.test(text)) throw new Error(`waktu tidak valid: ${text}`);
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function atempoChain(factor) {
  // atempo hanya 0.5–2.0 per filter; rantai untuk nilai di luar itu.
  const chain = [];
  let rest = factor;
  while (rest > 2) { chain.push("atempo=2.0"); rest /= 2; }
  while (rest < 0.5) { chain.push("atempo=0.5"); rest /= 0.5; }
  chain.push(`atempo=${rest.toFixed(4)}`);
  return chain.join(",");
}

function pickFont() {
  return FONT_CANDIDATES.find((file) => fs.existsSync(file)) || null;
}

/**
 * @param {object} args
 * @param {string} args.workdir folder kerja chat
 * @param {string[]} args.inputs nama file relatif di workdir (input utama dulu, lalu klip gabungan)
 * @param {Array} args.steps operasi
 * @param {string} args.output sticker|mp4|gif|mp3|frames|compress
 * @returns {Promise<{files: Array<{name, path, kind, mime}>, info: object}>}
 */
async function editMedia({ workdir, inputs, steps = [], output = "mp4", frames = 4, targetMb = 8 }) {
  if (!inputs?.length) throw new Error("tidak ada media masukan");
  for (const name of inputs) {
    const file = path.resolve(workdir, name);
    if (!file.startsWith(path.resolve(workdir) + path.sep)) throw new Error(`file ${name} di luar folder kerja`);
    if (!fs.existsSync(file)) throw new Error(`file ${name} tidak ada`);
    if (fs.statSync(file).size > MAX_INPUT_BYTES) throw new Error("media masukan terlalu besar (maks 64 MB)");
  }
  const outDir = path.join(workdir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const base = `edit_${Date.now().toString(36)}`;

  // 1) Gabung klip (bila ada) menjadi satu berkas kerja.
  let source = inputs[0];
  const concat = steps.find((step) => step.op === "concat");
  if (concat || inputs.length > 1) {
    const infos = await Promise.all(inputs.map((name) => probe(name, workdir)));
    const withAudio = infos.every((info) => info.hasAudio);
    const inArgs = inputs.flatMap((name) => ["-i", name]);
    const scaled = inputs.map((_, i) => `[${i}:v]scale=720:-2:force_original_aspect_ratio=decrease,pad=720:ceil(ih/2)*2:(ow-iw)/2:0,setsar=1,fps=30[v${i}]`).join(";");
    const pairs = inputs.map((_, i) => `[v${i}]${withAudio ? `[${i}:a]` : ""}`).join("");
    const filter = `${scaled};${pairs}concat=n=${inputs.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`;
    source = `${base}_concat.mp4`;
    await run(ffmpegBin(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", ...inArgs,
      "-filter_complex", filter, "-map", "[v]", ...(withAudio ? ["-map", "[a]"] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", source], { cwd: workdir, timeoutMs: 180_000 });
  }

  const info = await probe(source, workdir);
  if (info.duration > MAX_DURATION_SEC && !steps.some((step) => step.op === "trim")) throw new Error("media lebih dari 10 menit; potong dulu (trim)");

  // 2) Susun filter dari operasi.
  const inputArgs = [];
  const vf = [];
  const af = [];
  let mute = false;
  let duration = info.duration;
  for (const step of steps) {
    switch (step.op) {
      case "concat":
        break;
      case "trim": {
        const start = step.start != null ? seconds(step.start) : 0;
        const end = step.end != null ? seconds(step.end) : null;
        if (end != null && end <= start) throw new Error("trim: end harus setelah start");
        inputArgs.push("-ss", String(start));
        if (end != null) inputArgs.push("-to", String(end));
        duration = (end ?? duration) - start;
        break;
      }
      case "speed": {
        const factor = Number(step.factor);
        if (!(factor >= 0.25 && factor <= 4)) throw new Error("speed: faktor 0.25–4");
        vf.push(`setpts=${(1 / factor).toFixed(4)}*PTS`);
        af.push(atempoChain(factor));
        duration /= factor;
        break;
      }
      case "resize": {
        const width = Math.round(Number(step.width));
        if (!(width >= 64 && width <= 1920)) throw new Error("resize: lebar 64–1920");
        vf.push(`scale=${width}:-2`);
        break;
      }
      case "crop_square":
        vf.push("crop='min(iw,ih)':'min(iw,ih)'");
        break;
      case "reverse":
        if (duration > 30) throw new Error("reverse maksimal 30 detik (potong dulu)");
        vf.push("reverse");
        af.push("areverse");
        break;
      case "mute":
        mute = true;
        break;
      case "text": {
        const font = pickFont();
        if (!font) throw new Error("font untuk teks tidak tersedia di server");
        const text = String(step.text || "").slice(0, 120);
        if (!text.trim()) throw new Error("text: teks kosong");
        // Teks & font lewat file relatif (cwd = workdir) supaya tidak ada injeksi sintaks filter.
        fs.copyFileSync(font, path.join(workdir, `${base}_font.ttf`));
        fs.writeFileSync(path.join(workdir, `${base}_text.txt`), text);
        const y = { top: "h*0.06", center: "(h-text_h)/2", bottom: "h-text_h-h*0.06" }[step.position] || "h-text_h-h*0.06";
        const size = Math.min(160, Math.max(12, Number(step.size) || 0)) || "h/10";
        vf.push(`drawtext=fontfile=${base}_font.ttf:textfile=${base}_text.txt:fontsize=${size}:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${y}`);
        break;
      }
      default:
        throw new Error(`operasi tidak dikenal: ${step.op}`);
    }
  }
  if (!info.hasVideo && ["sticker", "gif", "frames"].includes(output)) throw new Error(`${output} butuh video/gambar, bukan audio`);

  const common = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-protocol_whitelist", "file", ...inputArgs, "-i", source];
  const files = [];
  const addFile = (name, kind, mime) => {
    const full = path.join(outDir, name);
    const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
    if (!size) throw new Error("hasil kosong");
    if (size > MAX_OUTPUT_BYTES) throw new Error("hasil lebih dari 16 MB; potong atau kompres dulu");
    files.push({ name, path: full, kind, mime, size });
  };
  const videoFilter = (extra = []) => {
    const all = [...vf, ...extra];
    return all.length ? ["-vf", all.join(",")] : [];
  };
  const audioFilter = () => (af.length && !mute && info.hasAudio ? ["-af", af.join(",")] : []);

  switch (output) {
    case "sticker": {
      // Stiker WhatsApp: WebP 512×512 transparan, animasi maks 6 detik dan < 1 MB.
      const animated = info.duration > 0.2;
      for (const [fps, quality] of [[15, 60], [12, 45], [10, 30], [8, 20]]) {
        const name = `${base}.webp`;
        const fit = "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba";
        await run(ffmpegBin(), [...common, ...videoFilter(animated ? [`fps=${fps}`, fit] : [fit]), "-an", ...(animated ? ["-t", "6", "-loop", "0", "-c:v", "libwebp_anim"] : ["-frames:v", "1", "-c:v", "libwebp"]), "-q:v", String(quality), "-compression_level", "6", path.join("out", name)], { cwd: workdir });
        if (fs.statSync(path.join(outDir, name)).size <= STICKER_MAX_BYTES || !animated) {
          addFile(name, "sticker", "image/webp");
          break;
        }
      }
      if (!files.length) throw new Error("stiker animasi tetap > 1 MB; potong jadi lebih pendek");
      break;
    }
    case "gif": {
      // WhatsApp menampilkan GIF sebagai MP4 tanpa suara dengan gifPlayback.
      const name = `${base}.mp4`;
      await run(ffmpegBin(), [...common, ...videoFilter(["fps=15", "scale='min(480,iw)':-2"]), "-an", "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join("out", name)], { cwd: workdir });
      addFile(name, "gif", "video/mp4");
      break;
    }
    case "mp3": {
      if (!info.hasAudio) throw new Error("media ini tidak punya audio");
      const name = `${base}.mp3`;
      await run(ffmpegBin(), [...common, "-vn", ...audioFilter(), "-c:a", "libmp3lame", "-q:a", "4", path.join("out", name)], { cwd: workdir });
      addFile(name, "audio", "audio/mpeg");
      break;
    }
    case "frames": {
      const count = Math.min(8, Math.max(1, Math.round(Number(frames) || 4)));
      const every = Math.max(0.1, (duration || 1) / count);
      await run(ffmpegBin(), [...common, ...videoFilter([`fps=1/${every.toFixed(3)}`]), "-frames:v", String(count), path.join("out", `${base}_%02d.png`)], { cwd: workdir });
      for (const name of fs.readdirSync(outDir).filter((n) => n.startsWith(`${base}_`) && n.endsWith(".png")).sort()) addFile(name, "image", "image/png");
      break;
    }
    case "mp4":
    case "compress": {
      const name = `${base}.mp4`;
      const args = [...common];
      if (output === "compress") {
        const target = Math.min(15, Math.max(1, Number(targetMb) || 8));
        const audioKbps = mute || !info.hasAudio ? 0 : 96;
        const videoKbps = Math.max(150, Math.floor((target * 8 * 1024 * 0.92) / Math.max(1, duration)) - audioKbps);
        args.push(...videoFilter(["scale='min(1280,iw)':-2"]), "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`);
      } else {
        args.push(...videoFilter(), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24");
      }
      if (mute || !info.hasAudio) args.push("-an");
      else args.push(...audioFilter(), "-c:a", "aac", "-b:a", "96k");
      args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join("out", name));
      if (!info.hasVideo) throw new Error("mp4 butuh video; untuk audio pakai mp3");
      await run(ffmpegBin(), args, { cwd: workdir, timeoutMs: 180_000 });
      addFile(name, "video", "video/mp4");
      break;
    }
    default:
      throw new Error(`format keluaran tidak dikenal: ${output}`);
  }
  // Berkas bantu (gabungan, font, teks) tidak perlu disimpan.
  for (const name of fs.readdirSync(workdir)) if (name.startsWith(`${base}_`)) fs.rmSync(path.join(workdir, name), { force: true });
  return { files, info: { duration: Number(duration.toFixed(2)), width: info.width, height: info.height } };
}

module.exports = { editMedia, probe, seconds };
