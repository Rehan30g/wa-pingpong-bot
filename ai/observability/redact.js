const SENSITIVE_KEYS = new Set([
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "cookie",
  "cookies",
  "set-cookie",
  "private_key",
  "credentials",
]);

function maskPhone(phone) {
  if (typeof phone !== "string") return phone;
  const cleaned = phone.trim();
  if (cleaned.length < 8) return "[REDACTED_PHONE]";
  // Pertahankan 4 digit awal dan 4 digit akhir untuk jejak audit
  return `${cleaned.slice(0, 5)}****${cleaned.slice(-4)}`;
}

function redactString(text) {
  if (typeof text !== "string") return text;

  let result = text;

  // 1. Redact Authorization Header & Tokens
  result = result.replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]");
  result = result.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  result = result.replace(/sk-or-v1-[A-Za-z0-9_-]{16,}/gi, "sk-or-v1-[REDACTED]");
  result = result.replace(/AIzaSy[A-Za-z0-9_-]{20,}/gi, "AIzaSy[REDACTED]");

  // 2. Redact Data URL (gambar, video, audio, dll)
  result = result.replace(
    /data:((?:image|video|audio|application)\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi,
    (_match, mime, data) => `[REDACTED_DATA_URL: ${mime}, ${data.length} chars]`,
  );

  // 3. Redact Base64 blob panjang (> 80 karakter base64 murni)
  result = result.replace(
    /(?:[A-Za-z0-9+/]{4}){20,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g,
    (match) => `[REDACTED_BASE64: ${match.length} chars]`,
  );

  return result;
}

function redactObject(value, options = {}) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, options));
  }

  if (typeof value === "object") {
    const output = {};
    for (const [key, val] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();

      // Sensor key rahasia
      if (SENSITIVE_KEYS.has(lowerKey)) {
        output[key] = "[REDACTED]";
        continue;
      }

      // Sensor nomor telepon jika diminta
      if (options.maskPhones && (lowerKey === "phone" || lowerKey === "sender_id" || lowerKey === "senderid")) {
        output[key] = maskPhone(val);
        continue;
      }

      output[key] = redactObject(val, options);
    }
    return output;
  }

  return value;
}

module.exports = {
  redactString,
  redactObject,
  maskPhone,
};
