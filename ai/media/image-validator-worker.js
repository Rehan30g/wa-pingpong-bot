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
    const options = { limitInputPixels: 16_000_000, failOn: "error" };
    const info = await sharp(source, options).metadata();
    if (!["jpeg", "png", "webp"].includes(info.format) || info.pages > 1 || !info.width || !info.height) throw new Error("image_format_invalid");
    await sharp(source, options).resize(1, 1).png().toBuffer();
    process.stdout.write(JSON.stringify({ mime: `image/${info.format}`, width: info.width, height: info.height }));
  } catch {
    process.exitCode = 2;
  }
});
