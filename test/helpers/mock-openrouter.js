const http = require("node:http");

// Mock OpenRouter untuk tes agent loop. `chat` adalah antrean respons
// /chat/completions; tiap item: string (content), atau { content, tool_calls,
// annotations, cost, delayMs } atau { status, error } untuk respons error. Item terakhir dipakai ulang bila antrean habis.
function createMockOpenRouter({ decision = { choice: "reply", confidence: 0.95 }, opportunity = { choice: "none", confidence: 0.9 }, chat = ["Oke."] } = {}) {
  const state = { decisions: [], chat: [], audio: [] };
  const script = { decision, opportunity, effort: null, chat: [...chat], audio: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/alpha/decisions") {
        state.decisions.push(payload);
        res.end(JSON.stringify({ answers: { action: script.decision, gratitude_target: { choice: "not_gratitude", confidence: 0.99 }, intent: { choice: "question", confidence: 0.9 }, opportunity: script.opportunity, ...(script.effort ? { effort: script.effort } : {}) } }));
        return;
      }
      if (req.url === "/api/v1/chat/completions") {
        const isAudio = JSON.stringify(payload.messages || []).includes("input_audio");
        if (isAudio) {
          state.audio.push(payload);
          res.end(JSON.stringify({ choices: [{ message: { content: script.audio || "{}" } }], usage: { cost: 0.0005 } }));
          return;
        }
        state.chat.push(payload);
        const item = script.chat.length > 1 ? script.chat.shift() : script.chat[0];
        const step = typeof item === "string" ? { content: item } : item;
        if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        // { status: 502, error: "..." } = respons error OpenRouter.
        if (step.status) {
          res.statusCode = step.status;
          res.end(JSON.stringify({ error: { message: step.error || "error", code: step.status } }));
          return;
        }
        const message = { role: "assistant", content: step.content ?? null };
        if (step.tool_calls) message.tool_calls = step.tool_calls;
        if (step.annotations) message.annotations = step.annotations;
        res.end(JSON.stringify({
          choices: [{ message, finish_reason: step.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: step.cost ?? 0.001 },
        }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const old = {};
  return {
    state,
    script,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      for (const key of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_PROXY_URL", "OPENROUTER_MAX_RETRIES"]) old[key] = process.env[key];
      process.env.OPENROUTER_API_KEY = "test-key";
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      process.env.OPENROUTER_PROXY_URL = "";
      process.env.OPENROUTER_MAX_RETRIES = "0";
      return this;
    },
    async stop() {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function toolCall(name, args, id = `call_${name}_${Math.random().toString(16).slice(2, 8)}`) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

module.exports = { createMockOpenRouter, toolCall };
