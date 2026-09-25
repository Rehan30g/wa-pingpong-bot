const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

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

function validateUrl(raw, allowedHosts) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("web_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("web_url_forbidden");
  if (url.search || url.hash) throw new Error("web_url_query_forbidden");
  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname.toLowerCase())) throw new Error("web_host_not_allowed");
  if (net.isIP(url.hostname) && !isPublicAddress(url.hostname)) throw new Error("web_private_address");
  return url;
}

async function resolvePublic(hostname, resolver = dns.lookup) {
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error("web_private_address");
  return addresses[0];
}

function requestText(url, address, { request = https.request, maxBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = request(url, {
      method: "GET", timeout: timeoutMs, maxRedirects: 0, signal,
      headers: { Accept: "text/plain, text/html", "Accept-Encoding": "identity", "User-Agent": "GradAgent/1.0" },
      lookup: (_host, _opts, callback) => callback(null, address.address, address.family),
    }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) { res.resume(); return finish(null, { redirect: res.headers.location }); }
      if (status !== 200) { res.resume(); return finish(new Error("web_http_status")); }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { res.resume(); return finish(new Error("web_encoding_forbidden")); }
      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) { res.resume(); return finish(new Error("web_size_limit")); }
      const mime = String(res.headers["content-type"] || "").split(";")[0].toLowerCase();
      if (!["text/plain", "text/html"].includes(mime)) { res.resume(); return finish(new Error("web_content_type")); }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error("web_size_limit")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => finish(null, { mime, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (error) => finish(error));
    });
    req.on("timeout", () => req.destroy(new Error("web_timeout")));
    req.on("error", (error) => finish(error));
    req.end();
  });
}

async function safeWebFetch(rawUrl, {
  allowedHosts = [], resolver = dns.lookup, request = https.request,
  maxBytes = 256 * 1024, timeoutMs = 5000, maxRedirects = 2, signal,
} = {}) {
  let url = validateUrl(rawUrl, allowedHosts);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (signal?.aborted) throw new Error("web_cancelled");
    const address = await resolvePublic(url.hostname, resolver);
    if (signal?.aborted) throw new Error("web_cancelled");
    const result = await requestText(url, address, { request, maxBytes, timeoutMs, signal });
    if (!result.redirect) {
      const text = result.mime === "text/html"
        ? result.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
        : result.body;
      const normalizedText = text.replace(/\s+/g, " ").trim().slice(0, 12000);
      if (!normalizedText) throw new Error("web_empty_content");
      return { url: `${url.origin}${url.pathname}`, text: normalizedText, fetchedAt: new Date().toISOString() };
    }
    if (redirects === maxRedirects) throw new Error("web_redirect_limit");
    url = validateUrl(new URL(result.redirect, url).href, allowedHosts);
  }
  throw new Error("web_redirect_limit");
}

module.exports = { safeWebFetch, validateUrl, resolvePublic, isPublicAddress };
