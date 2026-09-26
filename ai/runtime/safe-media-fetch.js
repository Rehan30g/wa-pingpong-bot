const https = require("node:https");
const dns = require("node:dns").promises;
const { validateUrl, resolvePublic } = require("./safe-web-fetch");
const { validateImage } = require("../media/image-validator");

function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function requestBytes(url, address, { request, maxBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = request(url, {
      method: "GET",
      timeout: timeoutMs, signal,
      headers: { Accept: "image/jpeg,image/png,image/webp", "Accept-Encoding": "identity", "User-Agent": "GradAgent/1.0" },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) { res.resume(); finish(null, { redirect: res.headers.location }); return; }
      if (status !== 200) { res.resume(); finish(new Error("media_http_status")); return; }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        res.resume(); finish(new Error("media_encoding_forbidden")); return;
      }
      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        res.resume(); finish(new Error("media_size_limit")); return;
      }
      let bytes = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error("media_size_limit")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => finish(null, { buffer: Buffer.concat(chunks) }));
      res.on("error", (error) => finish(error));
    });
    req.on("timeout", () => req.destroy(new Error("media_timeout")));
    req.on("error", (error) => finish(error));
    req.end();
  });
}

async function safeMediaFetch(rawUrl, {
  allowedHosts = [], resolver = dns.lookup, request = https.request,
  maxBytes = 5 * 1024 * 1024, timeoutMs = 5000, maxRedirects = 2, signal, imageValidator = validateImage,
} = {}) {
  let url = validateUrl(rawUrl, allowedHosts);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (signal?.aborted) throw new Error("media_cancelled");
    const address = await resolvePublic(url.hostname, resolver);
    if (signal?.aborted) throw new Error("media_cancelled");
    const result = await requestBytes(url, address, { request, maxBytes, timeoutMs, signal });
    if (result.redirect) {
      if (redirects === maxRedirects) throw new Error("media_redirect_limit");
      url = validateUrl(new URL(result.redirect, url).href, allowedHosts);
      continue;
    }
    const mime = detectImageMime(result.buffer);
    if (!mime) throw new Error("media_magic_invalid");
    const decoded = await imageValidator(result.buffer);
    if (decoded.mime !== mime) throw new Error("media_decode_mismatch");
    return { buffer: result.buffer, mime, sourceUrl: `${url.origin}${url.pathname}`, fetchedAt: new Date().toISOString() };
  }
  throw new Error("media_redirect_limit");
}

module.exports = { safeMediaFetch, detectImageMime };
