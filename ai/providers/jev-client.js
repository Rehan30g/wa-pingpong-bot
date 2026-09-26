const { createOpenRouterClient, OpenRouterError } = require("./openrouter-client");

function choiceConfidence(answer) {
  if (!answer) return 0;
  if (Number.isFinite(answer.confidence)) return answer.confidence;
  return Number(answer.probabilities?.[answer.choice]) || 0;
}

function createJevClient(options = {}) {
  const defaultModel = options.model || process.env.JEV_MODEL || "typesafe/jev-1.13";
  const openrouterClient = options.client || createOpenRouterClient(options);

  // Pertanyaan boleh ditandai { optional: true } (tidak dikirim ke API): jawaban
  // yang hilang tidak menggagalkan seluruh keputusan, cukup dilewati.
  async function decide({ model = defaultModel, sessionId, state, questions, user }) {
    if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) {
      throw new OpenRouterError("Parameter 'questions' wajib diisi untuk keputusan Jev", {
        category: "invalid_request",
      });
    }

    const start = Date.now();
    const payload = {
      model,
      session_id: String(sessionId || "default-session").slice(0, 256),
      state: state || {},
      questions: Object.fromEntries(Object.entries(questions || {}).map(([key, { optional, ...question }]) => [key, question])),
    };
    if (user) payload.user = String(user);

    const raw = await openrouterClient.post("/api/alpha/decisions", payload);
    const latencyMs = Date.now() - start;

    if (!raw || typeof raw !== "object") {
      throw new OpenRouterError("Respons Jev bukan objek JSON valid", {
        category: "malformed_response",
      });
    }

    const answers = raw.answers;
    if (!answers || typeof answers !== "object") {
      throw new OpenRouterError("Respons Jev tidak memiliki properti 'answers'", {
        category: "malformed_response",
        data: raw,
      });
    }

    const validatedAnswers = {};
    for (const [key, qConfig] of Object.entries(questions)) {
      const ans = answers[key];
      if ((!ans || typeof ans !== "object") && qConfig?.optional) continue;
      if (!ans || typeof ans !== "object") {
        throw new OpenRouterError(`Jawaban Jev untuk pertanyaan '${key}' tidak ditemukan`, {
          category: "malformed_response",
          data: answers,
        });
      }

      const choice = ans.choice;
      if (typeof choice !== "string") {
        throw new OpenRouterError(`Pilihan Jev untuk '${key}' tidak valid`, {
          category: "malformed_response",
          data: ans,
        });
      }

      // Validasi choice terhadap kriteria yang didaftarkan caller
      const allowedChoices = qConfig.criteria ? Object.keys(qConfig.criteria) : null;
      if (allowedChoices && !allowedChoices.includes(choice)) {
        throw new OpenRouterError(
          `Pilihan Jev '${choice}' untuk '${key}' tidak terdaftar dalam kriteria caller (${allowedChoices.join(", ")})`,
          {
            category: "malformed_response",
            data: { choice, allowedChoices },
          },
        );
      }

      const conf = choiceConfidence(ans);
      const probabilities = ans.probabilities && typeof ans.probabilities === "object" ? ans.probabilities : {};

      validatedAnswers[key] = {
        choice,
        confidence: conf,
        probabilities,
        type: ans.type || "choice",
      };
    }

    return {
      id: raw.id || null,
      sessionId,
      model: raw.model || model,
      provider: raw.provider || "OpenRouter",
      latencyMs,
      usage: raw.usage || { input_tokens: 0, output_tokens: 0, cost: 0 },
      answers: validatedAnswers,
    };
  }

  return {
    decide,
    choiceConfidence,
    client: openrouterClient,
  };
}

module.exports = {
  createJevClient,
  choiceConfidence,
};
