const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7],
  ["fe80::", 10], ["2001:db8::", 32], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return Boolean(family) && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

// allowedHosts "*" = host publik mana pun (agent loop M1). Proteksi SSRF tetap
// lewat resolvePublic/isPublicAddress di setiap hop redirect.
function validateUrl(raw, allowedHosts, { allowQuery = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("web_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("web_url_forbidden");
  if (!allowQuery && (url.search || url.hash)) throw new Error("web_url_query_forbidden");
  url.hash = "";
  if (allowedHosts !== "*" && (!Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname.toLowerCase()))) throw new Error("web_host_not_allowed");
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("web_private_address");
  return url;
}

// Pilih alamat publik (IPv4 diutamakan). Beberapa router/DNS ikut mengembalikan
// IPv6 privat (fd00::/8) di samping IPv4 publik; yang privat diabaikan. Koneksi
// selalu dipin ke alamat terpilih, jadi DNS rebinding tetap tertutup.
async function resolvePublic(hostname, resolver = dns.lookup) {
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.filter((entry) => isPublicAddress(entry.address));
  if (!publicAddresses.length) throw new Error("web_private_address");
  return publicAddresses.find((entry) => entry.family === 4) || publicAddresses[0];
}

const DECODERS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

function requestText(url, address, { request = https.request, maxBytes, timeoutMs, signal, decompress = false }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = request(url, {
      method: "GET", timeout: timeoutMs, maxRedirects: 0, signal,
      headers: {
        Accept: "text/plain, text/html",
        "Accept-Encoding": decompress ? "gzip, deflate, br" : "identity",
        "User-Agent": decompress ? "Mozilla/5.0 (compatible; GradAgent/1.1)" : "GradAgent/1.0",
      },
      // Node >=20 (autoSelectFamily) memanggil lookup dengan {all:true} dan
      // mengharapkan array; alamat tetap dipin ke hasil resolvePublic (anti DNS rebinding).
      lookup: (_host, opts, callback) => (opts?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family)),
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) { res.resume(); return finish(null, { redirect: res.headers.location }); }
      if (status !== 200) { res.resume(); return finish(new Error("web_http_status")); }
      const encoding = String(res.headers["content-encoding"] || "identity").toLowerCase();
      if (encoding !== "identity" && !(decompress && DECODERS[encoding])) { res.resume(); return finish(new Error("web_encoding_forbidden")); }
      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) { res.resume(); return finish(new Error("web_size_limit")); }
      const mime = String(res.headers["content-type"] || "").split(";")[0].toLowerCase();
      const allowedMimes = decompress ? ["text/plain", "text/html", "application/xhtml+xml"] : ["text/plain", "text/html"];
      if (!allowedMimes.includes(mime)) { res.resume(); return finish(new Error("web_content_type")); }
      const chunks = [];
      let bytes = 0;
      const body = encoding === "identity" ? res : res.pipe(DECODERS[encoding]());
      body.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error("web_size_limit")); return; }
        chunks.push(chunk);
      });
      body.on("end", () => finish(null, { mime, body: Buffer.concat(chunks).toString("utf8") }));
      body.on("error", (error) => finish(error));
      res.on("error", (error) => finish(error));
    });
    req.on("timeout", () => req.destroy(new Error("web_timeout")));
    req.on("error", (error) => finish(error));
    req.end();
  });
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? match;
    const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " "));
}

async function safeWebFetch(rawUrl, {
  allowedHosts = [], resolver = dns.lookup, request = https.request,
  maxBytes = 256 * 1024, timeoutMs = 5000, maxRedirects = 2, signal,
  allowQuery = false, decompress = false, maxChars = 12000,
} = {}) {
  let url = validateUrl(rawUrl, allowedHosts, { allowQuery });
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (signal?.aborted) throw new Error("web_cancelled");
    const address = await resolvePublic(url.hostname, resolver);
    if (signal?.aborted) throw new Error("web_cancelled");
    const result = await requestText(url, address, { request, maxBytes, timeoutMs, signal, decompress });
    if (!result.redirect) {
      const isHtml = result.mime !== "text/plain";
      const title = isHtml ? decodeEntities((result.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim()).slice(0, 200) : "";
      // Utamakan isi artikel supaya teks tidak habis oleh menu/navigasi.
      const main = isHtml ? result.body.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] : null;
      const text = isHtml ? htmlToText(main && htmlToText(main).trim().length > 500 ? main : result.body) : result.body;
      const normalizedText = text.replace(/\s+/g, " ").trim().slice(0, maxChars);
      if (!normalizedText) throw new Error("web_empty_content");
      return { url: `${url.origin}${url.pathname}`, ...(title ? { title } : {}), text: normalizedText, fetchedAt: new Date().toISOString() };
    }
    if (redirects === maxRedirects) throw new Error("web_redirect_limit");
    url = validateUrl(new URL(result.redirect, url).href, allowedHosts, { allowQuery });
  }
  throw new Error("web_redirect_limit");
}

module.exports = { safeWebFetch, validateUrl, resolvePublic, isPublicAddress, htmlToText };
