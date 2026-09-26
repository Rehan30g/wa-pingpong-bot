const sharp = require("sharp");

const chunks = [];
let bytes = 0;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > 5 * 1024 * 1024) process.exit(2);
  chunks.push(chunk);
});
process.stdin.on("end", async () => {
  try {
    const source = Buffer.concat(chunks);
    const info = await sharp(source, { limitInputPixels: 16_000_000, failOn: "error" }).metadata();
    if (!["jpeg", "png", "webp"].includes(info.format) || info.pages > 1) throw new Error("sticker_format_invalid");
    const output = await sharp(source, { limitInputPixels: 16_000_000, failOn: "error" })
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
    if (output.length > 512 * 1024) throw new Error("sticker_output_too_large");
    process.stdout.write(output);
  } catch {
    process.exitCode = 2;
  }
});
