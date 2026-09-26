// HTTP umum untuk sandbox Python (M4b): dipanggil proses bot atas permintaan
// sandbox, karena sandbox sendiri tidak punya akses jaringan. Proteksi SSRF sama
// dengan web_fetch: host harus resolve ke IP publik, dipin per hop redirect.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");
const dns = require("node:dns").promises;
const { isPublicAddress, resolvePublic } = require("../runtime/safe-web-fetch");

const DECODERS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
const BLOCKED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer"]);

function validateTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("url_tidak_valid"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("hanya_http_https");
  if (url.username || url.password) throw new Error("kredensial_di_url_dilarang");
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) throw new Error("port_non_standar_dilarang");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error("alamat_privat_dilarang");
  url.hash = "";
  return url;
}

function send(url, address, { method, headers, body, maxBytes, timeoutMs }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = client.request(url, {
      method,
      timeout: timeoutMs,
      headers: { "User-Agent": "GradPython/1.0", "Accept-Encoding": "gzip, deflate, br", ...headers },
      lookup: (_host, opts, callback) => (opts?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family)),
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(null, { redirect: res.headers.location, status });
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) { res.resume(); return done(new Error("respons_terlalu_besar")); }
      const encoding = String(res.headers["content-encoding"] || "identity").toLowerCase();
      const stream = DECODERS[encoding] ? res.pipe(DECODERS[encoding]()) : res;
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error("respons_terlalu_besar")); return; }
        chunks.push(chunk);
      });
      stream.on("end", () => done(null, {
        status,
        headers: { "content-type": res.headers["content-type"] || "" },
        body: Buffer.concat(chunks),
      }));
      stream.on("error", done);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", done);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {{url: string, method?: string, headers?: object, body?: Buffer|string|null}} request
 * @returns {Promise<{status: number, url: string, headers: object, body: Buffer}>}
 */
async function safeHttpRequest(request, { maxBytes = 5 * 1_048_576, timeoutMs = 15_000, maxRedirects = 4, resolver = dns.lookup } = {}) {
  let method = String(request.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new Error("metode_tidak_didukung");
  const headers = Object.fromEntries(Object.entries(request.headers || {})
    .filter(([key]) => !BLOCKED_HEADERS.has(String(key).toLowerCase()))
    .map(([key, value]) => [key, String(value).slice(0, 2_000)]));
  let body = request.body == null ? null : Buffer.from(request.body);
  if (body && body.length > 1_048_576) throw new Error("body_terlalu_besar");
  let url = validateTarget(request.url);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const address = await resolvePublic(url.hostname.replace(/^\[|\]$/g, ""), resolver);
    const result = await send(url, address, { method, headers, body, maxBytes, timeoutMs });
    if (!result.redirect) return { ...result, url: url.href };
    if (hop === maxRedirects) throw new Error("terlalu_banyak_redirect");
    if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
    }
    url = validateTarget(new URL(result.redirect, url).href);
  }
  throw new Error("terlalu_banyak_redirect");
}

module.exports = { safeHttpRequest, validateTarget };
