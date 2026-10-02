const { createOpenRouterClient, OpenRouterError } = require("./openrouter-client");
const providerPicker = require("./provider-picker");

function sanitizeVideoParts(messages, supportsVideoDataUrl = false) {
  if (supportsVideoDataUrl || !Array.isArray(messages)) return messages;

  return messages.map((msg) => {
    if (!msg || !Array.isArray(msg.content)) return msg;

    const sanitizedContent = msg.content.map((part) => {
      if (part && part.type === "video_url") {
        return {
          type: "text",
          text: "[Pesan melampirkan video, namun analisis visual video belum didukung pada fase ini.]",
        };
      }
      return part;
    });

    return {
      ...msg,
      content: sanitizedContent,
    };
  });
}

// Pilihan provider OpenRouter per jenis langkah (2 Okt 2026). Tanpa preferensi,
// OpenRouter condong ke provider termurah (OpenInference fp4, ±19 token/dtk) dan
// obrolan singkat bisa 10 detik. Nilai env: kosong/"auto" = dipilih dari statistik
// live OpenRouter (provider-picker.js, cadangan daftar di bawah selama statistik
// belum termuat), "openrouter" = routing bawaan OpenRouter (termurah),
// "latency"/"throughput"/"price" = urutan dinamis OpenRouter, atau daftar tag
// provider dipisah koma (diurutkan, tetap boleh jatuh ke provider lain bila error/429).
//  - fast: langkah pertama tanpa tool (obrolan, jawaban singkat)
//  - balanced: langkah lanjutan tugas bertool (konteks panjang, harga input penting)
// Cadangan dari `npm run bench:providers` 2 Okt (35 provider, prompt Grad asli, 3×):
// Together p50 0,8 dtk (bawaan OpenRouter 5,7 dtk, plus typo & "lo/lu" dari fp4 murahan),
// StreamLake fp8 termurah di antara yang cepat (±$0,00017/panggilan, 1,1–2,2 dtk).
const DEFAULT_PROVIDER_TIERS = {
  fast: "together,io-net/fp8,friendli,deepinfra/fp4",
  balanced: "streamlake/fp8,together,deepinfra/fp4",
};

function providerPreference(tier, live = null) {
  if (!tier) return null;
  const key = `GLM_PROVIDER_${String(tier).toUpperCase()}`;
  let raw = String(process.env[key] ?? "").trim() || "auto";
  if (raw === "auto") {
    const order = live ? providerPicker.rankedOrder(tier, live) : null;
    if (order?.length) return { order, allow_fallbacks: true };
    raw = String(DEFAULT_PROVIDER_TIERS[tier] ?? "").trim();
  }
  if (!raw || raw === "openrouter") return null;
  if (["latency", "throughput", "price"].includes(raw)) return { sort: raw, allow_fallbacks: true };
  const order = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return order.length ? { order, allow_fallbacks: true } : null;
}

function createGlmClient(options = {}) {
  const defaultModel = options.model || process.env.CHAT_MODEL || "z-ai/glm-5.3-flash";
  const defaultReasoningEffort = options.reasoningEffort || process.env.GLM_REASONING_EFFORT || "low";
  const defaultSupportsVideo = options.supportsVideoDataUrl ?? (process.env.AI_PROVIDER_SUPPORTS_VIDEO === "true");
  const openrouterClient = options.client || createOpenRouterClient(options);
  const fetchProviderStats = async (model) => {
    const response = await openrouterClient.httpClient.get(`/api/v1/models/${model}/endpoints`, { timeout: 10_000 });
    return response.data?.data?.endpoints || [];
  };

  async function chatCompletion({
    model = defaultModel,
    messages,
    tools,
    toolChoice,
    responseFormat,
    maxTokens,
    temperature = 0.3,
    reasoningEffort = defaultReasoningEffort,
    supportsVideoDataUrl = defaultSupportsVideo,
    tier = null,
    signal,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new OpenRouterError("Parameter 'messages' wajib berupa array tidak kosong", {
        category: "invalid_request",
      });
    }

    const start = Date.now();
    const finalMessages = sanitizeVideoParts(messages, supportsVideoDataUrl);

    const payload = {
      model,
      messages: finalMessages,
      temperature,
      reasoning: { effort: reasoningEffort, exclude: true },
      usage: { include: true },
    };

    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      payload.max_tokens = maxTokens;
    }

    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = toolChoice || "auto";
    }

    if (responseFormat) {
      payload.response_format = responseFormat;
    }

    const provider = providerPreference(tier, { model, fetchEndpoints: fetchProviderStats });
    if (provider) payload.provider = provider;

    const response = await openrouterClient.post("/api/v1/chat/completions", payload, signal ? { signal } : undefined);
    const latencyMs = Date.now() - start;
    // Belajar dari kenyataan: provider di depan yang dilewati (429/error) diturunkan sementara.
    if (provider?.order && response?.provider) providerPicker.noteServed(provider.order, response.provider, Date.now(), model);

    if (!response || typeof response !== "object") {
      throw new OpenRouterError("Respons GLM bukan objek JSON valid", {
        category: "malformed_response",
      });
    }

    const choice = response.choices?.[0];
    const message = choice?.message || {};
    const text = typeof message.content === "string" ? message.content : (message.content ? JSON.stringify(message.content) : "");

    const toolCalls = [];
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const rawArgs = call.function?.arguments;
        const callId = typeof call.id === "string" ? call.id.trim() : "";
        const callName = typeof call.function?.name === "string" ? call.function.name.trim() : "";
        let parsedArgs = null;
        let parseError = null;

        if (!callId) {
          parseError = "Tool call ID kosong atau tidak valid";
        } else if (!callName) {
          parseError = "Tool call function name kosong";
        } else if (typeof rawArgs === "string") {
          try {
            parsedArgs = JSON.parse(rawArgs);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              parseError = "Argumen tool call harus berupa JSON object";
            }
          } catch (err) {
            parseError = `Gagal mengurai argumen JSON fungsi '${callName}': ${err.message}`;
          }
        } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          parsedArgs = rawArgs;
        } else {
          parseError = "Argumen tool call bukan object JSON yang valid";
        }

        toolCalls.push({
          id: callId || `call_${toolCalls.length}`,
          name: callName,
          arguments: parseError ? null : (parsedArgs || {}),
          ok: parseError === null,
          error: parseError,
        });
      }
    }

    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    const totalTokens = response.usage?.total_tokens || (promptTokens + completionTokens);

    // Estimasi biaya (GLM 5.3 Flash: prompt $0.15/1M, completion $0.50/1M)
    const cost = Number.isFinite(response.usage?.cost)
      ? response.usage.cost
      : Number(((promptTokens * 0.00000015) + (completionTokens * 0.0000005)).toFixed(8));

    return {
      id: response.id || null,
      model: response.model || model,
      provider: response.provider || "OpenRouter",
      latencyMs,
      finishReason: choice?.finish_reason || "stop",
      text,
      toolCalls,
      // Pesan asisten mentah dipakai ulang oleh agent loop (tool_calls harus dikirim balik apa adanya).
      message,
      annotations: Array.isArray(message.annotations) ? message.annotations : [],
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      cost,
    };
  }

  return {
    chatCompletion,
    client: openrouterClient,
    capabilities: {
      image: true,
      video: false, // Default upstream OpenRouter GLM Flash tidak mendukung base64 data URL video
      toolCalling: true,
      structuredOutput: true,
    },
  };
}

module.exports = {
  DEFAULT_PROVIDER_TIERS,
  createGlmClient,
  providerPreference,
  sanitizeVideoParts,
};
