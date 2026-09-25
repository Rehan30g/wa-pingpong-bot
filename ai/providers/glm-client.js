const { createOpenRouterClient, OpenRouterError } = require("./openrouter-client");

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

function createGlmClient(options = {}) {
  const defaultModel = options.model || process.env.CHAT_MODEL || "z-ai/glm-5.3-flash";
  const defaultReasoningEffort = options.reasoningEffort || process.env.GLM_REASONING_EFFORT || "low";
  const defaultSupportsVideo = options.supportsVideoDataUrl ?? (process.env.AI_PROVIDER_SUPPORTS_VIDEO === "true");
  const openrouterClient = options.client || createOpenRouterClient(options);

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

    const response = await openrouterClient.post("/api/v1/chat/completions", payload);
    const latencyMs = Date.now() - start;

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
  createGlmClient,
  sanitizeVideoParts,
};
