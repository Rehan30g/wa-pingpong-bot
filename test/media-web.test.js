const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { AssetStore, createRuntimeAssetStore } = require("../ai/media/asset-store");
const { safeWebFetch, isPublicAddress } = require("../ai/runtime/safe-web-fetch");
const { createWebFetchCapability } = require("../ai/capabilities/web-fetch");
const { safeMediaFetch, detectImageMime } = require("../ai/runtime/safe-media-fetch");
const { createMediaFetchCapability } = require("../ai/capabilities/media-fetch");
const { EgressLimiter } = require("../ai/runtime/egress-limiter");
const { routeTaskIntent } = require("../ai/runtime/intent-router");
const sharp = require("sharp");
const { convertSticker } = require("../ai/media/sticker-converter");
const { createMakeStickerCapability } = require("../ai/capabilities/make-sticker");
const { validateImage } = require("../ai/media/image-validator");

test("asset privat terikat chat/task, berintegritas, dan kedaluwarsa", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grad-assets-test-"));
  try {
    const store = new AssetStore({ root, ttlMs: 10000 });
    const saved = await store.put(Buffer.from("image"), { chatId: "chat-a", taskId: "task-a", mime: "image/jpeg" });
    await assert.rejects(store.read(saved.assetId, { chatId: "chat-b", taskId: "task-a" }), /asset_scope_denied/);
    const read = await store.read(saved.assetId, { chatId: "chat-a", taskId: "task-a" });
    assert.equal(read.buffer.toString(), "image");
    await assert.rejects(store.read("../secrets", { chatId: "chat-a", taskId: "task-a" }), /asset_id_invalid/);
    assert.equal(await store.cleanup(Date.now() + 20000), 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("shadow menolak root asset yang sama dengan agent", () => {
  const oldAgent = process.env.RUNTIME_ASSET_DIR;
  const oldShadow = process.env.RUNTIME_SHADOW_ASSET_DIR;
  try {
    process.env.RUNTIME_ASSET_DIR = path.join(os.tmpdir(), "same-asset-root");
    process.env.RUNTIME_SHADOW_ASSET_DIR = process.env.RUNTIME_ASSET_DIR;
    assert.throws(() => createRuntimeAssetStore("shadow"), /shadow_asset_root_conflict/);
  } finally {
    if (oldAgent === undefined) delete process.env.RUNTIME_ASSET_DIR; else process.env.RUNTIME_ASSET_DIR = oldAgent;
    if (oldShadow === undefined) delete process.env.RUNTIME_SHADOW_ASSET_DIR; else process.env.RUNTIME_SHADOW_ASSET_DIR = oldShadow;
  }
});

test("web menolak IP privat, URL berbahaya, dan redirect ke host lain", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fc00::1"]) assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  await assert.rejects(safeWebFetch("http://example.com", { allowedHosts: ["example.com"] }), /web_url_forbidden/);
  await assert.rejects(safeWebFetch("https://127.0.0.1", { allowedHosts: ["127.0.0.1"] }), /web_private_address/);
  await assert.rejects(safeWebFetch("https://example.com", { allowedHosts: ["example.com"], resolver: async () => [{ address: "10.0.0.4", family: 4 }] }), /web_private_address/);
  const request = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location: "https://internal.example/" };
      res.resume = () => {};
      callback(res);
    };
    return req;
  };
  await assert.rejects(safeWebFetch("https://example.com", { allowedHosts: ["example.com"], resolver: async () => [{ address: "8.8.8.8", family: 4 }], request }), /web_host_not_allowed/);
});

test("web read-only mengambil teks terbatas melalui IP DNS yang dipin", async () => {
  let pinned;
  const request = (_url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup("example.com", {}, (_error, address) => { pinned = address; });
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { "content-type": "text/html" };
      callback(res);
      queueMicrotask(() => { res.emit("data", Buffer.from("<script>secret()</script><h1>Judul</h1> Teks")); res.emit("end"); });
    };
    return req;
  };
  const result = await safeWebFetch("https://example.com/x", { allowedHosts: ["example.com"], resolver: async () => [{ address: "8.8.8.8", family: 4 }], request });
  assert.equal(pinned, "8.8.8.8");
  assert.equal(result.text, "Judul Teks");
  assert.equal(result.url, "https://example.com/x");
  await assert.rejects(safeWebFetch("https://example.com/x?token=secret", { allowedHosts: ["example.com"] }), /web_url_query_forbidden/);
  assert.equal(createWebFetchCapability().enabled, false);
});

test("web dan media berhenti saat dibatalkan sebelum egress", async () => {
  const abort = new AbortController();
  abort.abort();
  let requests = 0;
  const request = () => { requests++; throw new Error("request must not run"); };
  const options = { allowedHosts: ["example.com"], resolver: async () => [{ address: "8.8.8.8", family: 4 }], request, signal: abort.signal };
  await assert.rejects(safeWebFetch("https://example.com/x", options), /web_cancelled/);
  await assert.rejects(safeMediaFetch("https://example.com/x.jpg", options), /media_cancelled/);
  assert.equal(requests, 0);
});

test("web menolak encoding dan Content-Length yang melampaui batas", async () => {
  const makeRequest = (headers) => (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { "content-type": "text/plain", ...headers };
      res.resume = () => {};
      callback(res);
    };
    return req;
  };
  const options = { allowedHosts: ["example.com"], resolver: async () => [{ address: "8.8.8.8", family: 4 }], maxBytes: 4 };
  await assert.rejects(safeWebFetch("https://example.com/x", { ...options, request: makeRequest({ "content-encoding": "gzip" }) }), /web_encoding_forbidden/);
  await assert.rejects(safeWebFetch("https://example.com/x", { ...options, request: makeRequest({ "content-length": "5" }) }), /web_size_limit/);
});

test("media URL memvalidasi DNS, ukuran streaming, magic bytes, dan decode", async () => {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
  assert.equal(detectImageMime(jpeg), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("not an image")), null);
  const request = (_url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = (error) => req.emit("error", error);
    req.end = () => {
      options.lookup("example.com", {}, (_error, address) => assert.equal(address, "8.8.8.8"));
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      callback(res);
      queueMicrotask(() => { res.emit("data", jpeg); res.emit("end"); });
    };
    return req;
  };
  const options = { allowedHosts: ["example.com"], resolver: async () => [{ address: "8.8.8.8", family: 4 }], request };
  assert.equal((await safeMediaFetch("https://example.com/photo.jpg", options)).mime, "image/jpeg");
  await assert.rejects(safeMediaFetch("https://example.com/photo.jpg", { ...options, imageValidator: async () => ({ mime: "image/png" }) }), /media_decode_mismatch/);
  await assert.rejects(safeMediaFetch("https://example.com/photo.jpg", { ...options, maxBytes: 3 }), /media_size_limit/);
  await assert.rejects(safeMediaFetch("https://example.com/photo.jpg", { ...options, resolver: async () => [{ address: "10.0.0.1", family: 4 }] }), /web_private_address/);
  await assert.rejects(validateImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), /image_decode_invalid/);
});

test("redirect se-host ke DNS privat tetap ditolak sebelum request kedua", async () => {
  let requests = 0;
  let lookups = 0;
  const resolver = async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
  const request = (_url, _options, callback) => {
    requests++;
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location: "/next" };
      res.resume = () => {};
      callback(res);
    };
    return req;
  };
  const options = { allowedHosts: ["example.com"], resolver, request };
  await assert.rejects(safeWebFetch("https://example.com/start", options), /web_private_address/);
  assert.equal(requests, 1);
  lookups = 0;
  requests = 0;
  await assert.rejects(safeMediaFetch("https://example.com/start", options), /web_private_address/);
  assert.equal(requests, 1);
});

test("fetch_media_from_url terikat chat/task dan mati secara default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grad-media-cap-test-"));
  const previous = process.env.AGENT_MEDIA_ALLOWED_HOSTS;
  try {
    const store = new AssetStore({ root });
    const cap = createMediaFetchCapability({ assetStore: store, fetcher: async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0]), mime: "image/jpeg", sourceUrl: "https://example.com/a.jpg" }) });
    assert.equal(cap.enabled, false);
    process.env.AGENT_MEDIA_ALLOWED_HOSTS = "example.com";
    const context = { originChatId: "chat-a", taskId: "task-a", engineMode: "agent" };
    const result = await cap.handler({ url: "https://example.com/a.jpg" }, context);
    assert.equal((await cap.verifier(result, context)).ok, true);
    await assert.rejects(cap.verifier(result, { ...context, originChatId: "chat-b" }), /asset_scope_denied/);
    await assert.rejects(cap.handler({ url: "https://example.com/a.jpg" }, { ...context, engineMode: "shadow" }), /media_fetch_shadow_denied/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MEDIA_ALLOWED_HOSTS; else process.env.AGENT_MEDIA_ALLOWED_HOSTS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("kuota egress membatasi task dan host sebelum koneksi", () => {
  let now = 100_000;
  const limiter = new EgressLimiter({ perTask: 2, perHostPerMinute: 2, now: () => now });
  limiter.reserve("task-a", "https://example.com/a");
  limiter.reserve("task-a", "https://example.com/b");
  assert.throws(() => limiter.reserve("task-a", "https://other.com/c"), /egress_task_quota/);
  assert.throws(() => limiter.reserve("task-b", "https://example.com/c"), /egress_host_rate_limit/);
  now += 60_001;
  limiter.reserve("task-b", "https://example.com/c");
  assert.throws(() => limiter.reserve("", "https://example.com/a"), /egress_task_required/);
});

test("router hanya menerima perintah web/media saat capability diaktifkan", () => {
  const oldWeb = process.env.AGENT_WEB_FETCH_ENABLED;
  const oldMedia = process.env.AGENT_MEDIA_URL_ENABLED;
  try {
    delete process.env.AGENT_WEB_FETCH_ENABLED;
    delete process.env.AGENT_MEDIA_URL_ENABLED;
    assert.equal(routeTaskIntent("/task web https://example.com"), null);
    assert.equal(routeTaskIntent("/task ambil gambar https://example.com/a.jpg"), null);
    process.env.AGENT_WEB_FETCH_ENABLED = "true";
    process.env.AGENT_MEDIA_URL_ENABLED = "true";
    assert.equal(routeTaskIntent("/task web https://example.com").intent, "web_fetch");
    assert.equal(routeTaskIntent("/task ambil gambar https://example.com/a.jpg").intent, "fetch_media_from_url");
    assert.equal(routeTaskIntent("/task web http://example.com"), null);
    assert.equal(routeTaskIntent("/task web https://example.com/?key=private"), null);
  } finally {
    if (oldWeb === undefined) delete process.env.AGENT_WEB_FETCH_ENABLED; else process.env.AGENT_WEB_FETCH_ENABLED = oldWeb;
    if (oldMedia === undefined) delete process.env.AGENT_MEDIA_URL_ENABLED; else process.env.AGENT_MEDIA_URL_ENABLED = oldMedia;
  }
});

test("stiker diproses dalam child process menjadi WebP 512x512 dan tetap terikat task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grad-sticker-test-"));
  try {
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const webp = await convertSticker(png);
    assert.equal((await sharp(webp).metadata()).width, 512);
    assert.equal((await sharp(webp).metadata()).height, 512);
    const store = new AssetStore({ root });
    const source = await store.put(png, { chatId: "chat-a", taskId: "task-a", mime: "image/png" });
    const cap = createMakeStickerCapability({ assetStore: store });
    assert.equal(cap.enabled, false);
    const context = { originChatId: "chat-a", taskId: "task-a" };
    const result = await cap.handler({ asset_id: source.assetId }, context);
    assert.equal((await cap.verifier(result, context)).ok, true);
    await assert.rejects(cap.handler({ asset_id: source.assetId }, { originChatId: "chat-b", taskId: "task-a" }), /asset_scope_denied/);
    await assert.rejects(convertSticker(Buffer.from("invalid")), /sticker_conversion_failed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
