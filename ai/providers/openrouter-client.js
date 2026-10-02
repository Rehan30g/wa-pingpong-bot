const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

function sanitizeText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/sk-or-v1-[a-zA-Z0-9_-]{16,}/gi, "sk-or-v1-[REDACTED]")
    .replace(/data:(image|video|audio|application)\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_BASE64_MEDIA]");
}

function sanitizeCause(err) {
  if (!err || typeof err !== "object") return null;
  return {
    name: err.name || "Error",
    message: sanitizeText(err.message || ""),
    code: err.code || null,
    status: err.response?.status || null,
  };
}

class OpenRouterError extends Error {
  constructor(message, { category, status = null, retryable = false, cause = null, data = null } = {}) {
    super(sanitizeText(message));
    this.name = "OpenRouterError";
    this.category = category; // timeout | rate_limit | provider_error | invalid_request | unsupported_capability | malformed_response
    this.status = status;
    this.retryable = Boolean(retryable);
    this.cause = sanitizeCause(cause);
    this.data = data ? { status: data.status, message: sanitizeText(data.message || "") } : null;
  }
}

function classifyError(error) {
  if (error instanceof OpenRouterError) return error;

  // Timeout
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || /timeout/i.test(error.message || "")) {
    return new OpenRouterError(`Request ke OpenRouter timed out: ${error.message}`, {
      category: "timeout",
      status: 408,
      retryable: true,
      cause: error,
    });
  }

  // HTTP Response from server
  if (error.response) {
    const status = error.response.status;
    if (status >= 200 && status < 300 && ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) {
      return new OpenRouterError(`Koneksi OpenRouter terputus saat menerima respons (${error.code})`, {
        category: "provider_error", status, retryable: true, cause: error,
      });
    }
    const rawData = error.response.data;
    const msg = typeof rawData === "string"
      ? rawData
      : (rawData?.error?.message || rawData?.message || JSON.stringify(rawData || {}));
    const sanitizedMsg = sanitizeText(msg);

    // Unsupported capabilities (video, unsupported modality/tool)
    if (status === 400 || status === 422) {
      const isUnsupported = /video\s+(input|is\s+temporarily|not\s+supported)|must be provided as http\(s\)|limit-mm-per-prompt|unsupported\s+(model|feature|modality)/i.test(sanitizedMsg);
      if (isUnsupported) {
        return new OpenRouterError(`Kapabilitas tidak didukung provider: ${sanitizedMsg}`, {
          category: "unsupported_capability",
          status,
          retryable: false,
          cause: error,
          data: { status, message: sanitizedMsg },
        });
      }

      return new OpenRouterError(`Permintaan OpenRouter tidak valid (${status}): ${sanitizedMsg}`, {
        category: "invalid_request",
        status,
        retryable: false,
        cause: error,
        data: { status, message: sanitizedMsg },
      });
    }

    if (status === 401 || status === 403) {
      return new OpenRouterError(`Autentikasi/Otorisasi OpenRouter gagal (${status}): ${sanitizedMsg}`, {
        category: "invalid_request",
        status,
        retryable: false,
        cause: error,
        data: { status, message: sanitizedMsg },
      });
    }

    if (status === 429) {
      return new OpenRouterError(`OpenRouter rate limit tercapai (${status}): ${sanitizedMsg}`, {
        category: "rate_limit",
        status,
        retryable: true,
        cause: error,
        data: { status, message: sanitizedMsg },
      });
    }

    if (status >= 500) {
      return new OpenRouterError(`Error server OpenRouter (${status}): ${sanitizedMsg}`, {
        category: "provider_error",
        status,
        // Server tool (mis. openrouter:web_search) yang gagal tidak membaik bila payload
        // sama dikirim ulang (2 Okt: 3× ±22 dtk); agent loop mengulang tanpa tool itu.
        retryable: !/server tool/i.test(sanitizedMsg),
        cause: error,
        data: { status, message: sanitizedMsg },
      });
    }

    return new OpenRouterError(`Error HTTP OpenRouter (${status}): ${sanitizedMsg}`, {
      category: "provider_error",
      status,
      retryable: status >= 500,
      cause: error,
      data: { status, message: sanitizedMsg },
    });
  }

  // Network connection error
  if (error.code && ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH"].includes(error.code)) {
    return new OpenRouterError(`Koneksi jaringan ke OpenRouter gagal (${error.code}): ${error.message}`, {
      category: "provider_error",
      status: null,
      retryable: true,
      cause: error,
    });
  }

  // Malformed response / local error
  return new OpenRouterError(sanitizeText(error.message || "Unknown error"), {
    category: error.category || "malformed_response",
    status: null,
    retryable: false,
    cause: error,
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOpenRouterClient(options = {}) {
  const baseURL = options.baseURL || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai";
  const apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.OPENROUTER_API_KEY || "");
  const proxyUrl = options.proxyUrl !== undefined ? options.proxyUrl : (process.env.OPENROUTER_PROXY_URL || "");
  const timeoutMs = options.timeoutMs ?? (Number(process.env.OPENROUTER_TIMEOUT_MS) || 30_000);
  // `Number("0") || 2` dulu membuat OPENROUTER_MAX_RETRIES=0 terbaca 2 (jebakan envNumber).
  const envRetries = String(process.env.OPENROUTER_MAX_RETRIES ?? "").trim() === "" ? NaN : Number(process.env.OPENROUTER_MAX_RETRIES);
  const maxRetries = Math.max(0, options.maxRetries ?? (Number.isFinite(envRetries) ? envRetries : 2));
  const sleepFn = options.sleepFn || defaultSleep;
  const onRetry = options.onRetry || null;

  let httpInstance = options.httpClient;
  if (!httpInstance) {
    const axiosConfig = {
      baseURL,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://github.com/Rehan30g/wa-pingpong-bot",
        "X-Title": process.env.OPENROUTER_APP_NAME || "WA Group Agent",
      },
    };

    if (proxyUrl) {
      axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.proxy = false;
    }

    httpInstance = axios.create(axiosConfig);
  }

  async function request(endpoint, payload, requestConfig = {}) {
    let attempt = 0;
    while (true) {
      try {
        const response = await httpInstance.post(endpoint, payload, requestConfig);
        if (!response || response.data === undefined) {
          throw new OpenRouterError("Respons kosong dari provider", {
            category: "malformed_response",
            status: response ? response.status : null,
            retryable: false,
          });
        }
        return response.data;
      } catch (err) {
        const classified = classifyError(err);
        if (classified.retryable && attempt < maxRetries) {
          attempt++;
          if (typeof onRetry === "function") {
            try {
              await onRetry({
                attempt,
                category: classified.category,
                endpoint,
                error: classified,
              });
            } catch (retryErr) {
              // Jika hook onRetry menolak (misal TaskBudget retries habis), batalkan retry segera
              throw retryErr;
            }
          }
          // Exponential backoff with jitter
          const backoff = Math.min(2_000, 300 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 150));
          await sleepFn(backoff);
          continue;
        }
        throw classified;
      }
    }
  }

  // Sesuai prinsip least-privilege: apiKey dirahasiakan dalam closure dan TIDAK diekspos sebagai properti publik
  return {
    baseURL,
    proxyUrl,
    timeoutMs,
    maxRetries,
    httpClient: httpInstance,
    request,
    post: (endpoint, payload, config) => request(endpoint, payload, config),
  };
}

module.exports = {
  createOpenRouterClient,
  OpenRouterError,
  classifyError,
  sanitizeText,
  sanitizeCause,
};
