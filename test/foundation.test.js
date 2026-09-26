const { setupIsolatedTestEnv } = require("./helpers/test-env");
const { testDir, cleanup } = setupIsolatedTestEnv("wa-test-foundation-");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");

test.after(() => {
  cleanup();
});

const { createOpenRouterClient, OpenRouterError, classifyError } = require("../ai/providers/openrouter-client");
const { createJevClient, choiceConfidence } = require("../ai/providers/jev-client");
const { createGlmClient } = require("../ai/providers/glm-client");
const { SCOPES, CHANNEL_SCOPES, PERMISSION_SCOPES } = require("../ai/policy/scopes");
const { authorize, REASON_CODES } = require("../ai/policy/authorize");
const { TaskBudget, BudgetExhaustedError, DEFAULT_LIMITS, CONSERVATIVE_ESTIMATES } = require("../ai/runtime/budget");
const { redactString, redactObject, maskPhone } = require("../ai/observability/redact");
const { createTraceLogger, InMemorySink } = require("../ai/observability/trace");
const {
  createCapabilityRegistry,
  defaultRegistry,
  CapabilityExecutionError,
  buildIdempotencyKey,
  verifyIdempotencyKey,
} = require("../ai/capabilities/registry");
const groupAgent = require("../ai/group-agent");
const directAgent = require("../ai/direct-agent");
const memoryStore = require("../ai/memory-store");

// Helper actor valid untuk pengetesan
const VALID_ACTOR = Object.freeze({
  pn: "628123456789",
  verified: true,
  provenance: "test_harness",
  isOwner: false,
});

const VALID_OWNER_ACTOR = Object.freeze({
  pn: "628123456789",
  verified: true,
  provenance: "test_harness",
  isOwner: true,
});

// ============================================================================
// 1. OPENROUTER CLIENT, ERROR CLASSIFICATION, & SECRET HANDLING TESTS
// ============================================================================

test("classifyError mengklasifikasikan timeout, rate_limit, provider_error, dan invalid_request", () => {
  const interrupted = Object.assign(new Error("aborted"), { code: "ECONNRESET", response: { status: 200, data: {} } });
  const classifiedInterrupted = classifyError(interrupted);
  assert.equal(classifiedInterrupted.retryable, true);
  assert.equal(classifiedInterrupted.category, "provider_error");
  // Timeout
  const timeoutErr = new Error("connect ETIMEDOUT");
  timeoutErr.code = "ETIMEDOUT";
  const c1 = classifyError(timeoutErr);
  assert.equal(c1.category, "timeout");
  assert.equal(c1.retryable, true);

  // Rate limit
  const rateLimitErr = new Error("Rate limit exceeded");
  rateLimitErr.response = { status: 429, data: { error: { message: "Too many requests" } } };
  const c2 = classifyError(rateLimitErr);
  assert.equal(c2.category, "rate_limit");
  assert.equal(c2.retryable, true);

  // Provider error (500)
  const serverErr = new Error("Internal Server Error");
  serverErr.response = { status: 500, data: { error: { message: "Server error" } } };
  const c3 = classifyError(serverErr);
  assert.equal(c3.category, "provider_error");
  assert.equal(c3.retryable, true);

  // Unsupported capability (video base64 error)
  const videoErr = new Error("Bad Request");
  videoErr.response = {
    status: 400,
    data: { error: { message: "Video inputs must be provided as http(s) URLs; base64 data URLs are not supported for videos." } },
  };
  const c4 = classifyError(videoErr);
  assert.equal(c4.category, "unsupported_capability");
  assert.equal(c4.retryable, false);

  // Invalid request
  const invalidErr = new Error("Invalid request");
  invalidErr.response = { status: 400, data: { error: { message: "Invalid JSON schema" } } };
  const c5 = classifyError(invalidErr);
  assert.equal(c5.category, "invalid_request");
  assert.equal(c5.retryable, false);
});

test("openrouter-client melakukan retry hanya pada transient error dengan mock HTTP", async () => {
  let callCount = 0;
  const mockHttp = {
    post: async () => {
      callCount++;
      if (callCount < 2) {
        const err = new Error("Temporary 503 Server Error");
        err.response = { status: 503, data: { message: "Gateway temporarily unavailable" } };
        throw err;
      }
      return { data: { success: true, callCount } };
    },
  };

  const client = createOpenRouterClient({
    httpClient: mockHttp,
    maxRetries: 2,
    sleepFn: async () => {}, // instant sleep for test
  });

  const res = await client.request("/test", { dummy: 1 });
  assert.equal(res.success, true);
  assert.equal(callCount, 2, "Harus sukses pada percobaan ke-2 setelah retry");
});

test("openrouter-client tidak me-retry invalid_request atau unsupported_capability", async () => {
  let callCount = 0;
  const mockHttp = {
    post: async () => {
      callCount++;
      const err = new Error("Invalid schema");
      err.response = { status: 400, data: { message: "Missing required parameter" } };
      throw err;
    },
  };

  const client = createOpenRouterClient({
    httpClient: mockHttp,
    maxRetries: 2,
    sleepFn: async () => {},
  });

  await assert.rejects(
    async () => client.request("/test", {}),
    (err) => {
      assert.equal(err.category, "invalid_request");
      assert.equal(err.retryable, false);
      assert.equal(callCount, 1, "Tidak boleh di-retry");
      return true;
    },
  );
});

test("Point H: OpenRouter client dan error tidak mengekspos apiKey atau media base64", () => {
  const secretKey = "sk-or-v1-abcdef1234567890abcdef1234567890";
  const client = createOpenRouterClient({
    apiKey: secretKey,
    httpClient: { post: async () => ({ data: {} }) },
  });

  // 1. Properti publik client tidak memuat apiKey
  assert.equal(client.apiKey, undefined, "client.apiKey tidak boleh diekspos sebagai properti publik");
  const clientStr = JSON.stringify(client);
  assert.equal(clientStr.includes(secretKey), false, "JSON.stringify(client) tidak boleh memuat API key");

  // 2. OpenRouterError tidak memuat raw headers atau prompt/media dalam cause
  const fakeAxiosErr = new Error("Request failed with status code 400");
  fakeAxiosErr.code = "ERR_BAD_REQUEST";
  fakeAxiosErr.config = {
    headers: { Authorization: `Bearer ${secretKey}` },
    data: "data:video/mp4;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
  };
  fakeAxiosErr.response = {
    status: 400,
    data: { message: `Bad request using ${secretKey}` },
  };

  const openErr = classifyError(fakeAxiosErr);
  const errStr = JSON.stringify(openErr);
  assert.equal(errStr.includes(secretKey), false, "JSON.stringify(error) tidak boleh memuat API key");
  assert.equal(errStr.includes("QUJDREVGR0h"), false, "JSON.stringify(error) tidak boleh memuat base64 data");
  assert.equal(openErr.cause?.config, undefined, "cause tidak boleh memuat raw config Axios");
});

// ============================================================================
// 2. JEV ADAPTER TESTS
// ============================================================================

test("jev-client memvalidasi respons dan menolak pilihan yang tidak terdaftar", async () => {
  const mockHttp = {
    post: async () => ({
      data: {
        answers: {
          action: {
            choice: "unregistered_action_hack",
            confidence: 0.99,
          },
        },
      },
    }),
  };

  const jev = createJevClient({ httpClient: mockHttp });
  await assert.rejects(
    async () => jev.decide({
      model: "typesafe/jev-1.13",
      questions: {
        action: {
          type: "choice",
          instructions: "pilih",
          criteria: { reply: "balas", ignore: "diam" },
        },
      },
    }),
    /Pilihan Jev 'unregistered_action_hack' untuk 'action' tidak terdaftar dalam kriteria caller/,
  );
});

test("jev-client mengembalikan hasil normalisasi saat pilihan sah", async () => {
  const mockHttp = {
    post: async () => ({
      data: {
        answers: {
          action: {
            choice: "reply",
            confidence: 0.85,
            probabilities: { reply: 0.85, ignore: 0.15 },
          },
        },
      },
    }),
  };

  const jev = createJevClient({ httpClient: mockHttp });
  const res = await jev.decide({
    model: "typesafe/jev-1.13",
    sessionId: "wa-test-session",
    questions: {
      action: {
        type: "choice",
        instructions: "pilih",
        criteria: { reply: "balas", ignore: "diam" },
      },
    },
  });

  assert.equal(res.answers.action.choice, "reply");
  assert.equal(choiceConfidence(res.answers.action), 0.85);
  assert.equal(res.sessionId, "wa-test-session");
});

// ============================================================================
// 3. GLM ADAPTER & TOOL CALL SAFETY TESTS
// ============================================================================

test("Point I: glm-client memvalidasi toolCalls secara terstruktur dan menolak JSON/args rusak", async () => {
  const mockHttp = {
    post: async () => ({
      data: {
        id: "gen-glm-1",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_valid",
                  function: { name: "test_calc", arguments: '{"a":10,"b":20}' },
                },
                {
                  id: "call_broken_json",
                  function: { name: "test_calc", arguments: '{"a":10,"b":malformed}' },
                },
                {
                  id: "call_not_object",
                  function: { name: "test_calc", arguments: '"just a string"' },
                },
                {
                  id: "",
                  function: { name: "test_calc", arguments: '{"a":1}' },
                },
                {
                  id: "call_empty_name",
                  function: { name: "", arguments: '{"a":1}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 50 },
      },
    }),
  };

  const glm = createGlmClient({ httpClient: mockHttp });
  const result = await glm.chatCompletion({
    messages: [{ role: "user", content: "hitung" }],
  });

  assert.equal(result.toolCalls.length, 5);

  // 1. Valid tool call
  assert.equal(result.toolCalls[0].ok, true);
  assert.deepEqual(result.toolCalls[0].arguments, { a: 10, b: 20 });
  assert.equal(result.toolCalls[0].rawArguments, undefined, "rawArguments tidak boleh disimpan di toolCall");

  // 2. Broken JSON
  assert.equal(result.toolCalls[1].ok, false);
  assert.match(result.toolCalls[1].error, /Gagal mengurai argumen JSON/);
  assert.equal(result.toolCalls[1].arguments, null);

  // 3. Not an object
  assert.equal(result.toolCalls[2].ok, false);
  assert.match(result.toolCalls[2].error, /harus berupa JSON object/);

  // 4. Empty ID
  assert.equal(result.toolCalls[3].ok, false);
  assert.match(result.toolCalls[3].error, /ID kosong/);

  // 5. Empty Name
  assert.equal(result.toolCalls[4].ok, false);
  assert.match(result.toolCalls[4].error, /name kosong/);
});

test("glm-client mengonversi video_url ke metadata teks bila supportsVideoDataUrl false", async () => {
  let capturedPayload = null;
  const mockHttp = {
    post: async (_url, payload) => {
      capturedPayload = payload;
      return {
        data: {
          choices: [{ message: { content: "Paham, video diterima." } }],
        },
      };
    },
  };

  const glm = createGlmClient({ httpClient: mockHttp, supportsVideoDataUrl: false });
  await glm.chatCompletion({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Lihat video ini" },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,QUJD" } },
        ],
      },
    ],
  });

  assert.ok(capturedPayload);
  const userContent = capturedPayload.messages[0].content;
  assert.equal(userContent[1].type, "text");
  assert.match(userContent[1].text, /analisis visual video belum didukung/);
});

// ============================================================================
// 4. CAPABILITY REGISTRY, FACTORY, & SCHEMA CONTRACT TESTS
// ============================================================================

test("Point E: Registry production default bersih tanpa capability bawaan", () => {
  assert.equal(defaultRegistry.listCapabilities().length, 0, "Production defaultRegistry tidak boleh memuat test_echo/test_calc otomatis");
});

test("Point F: Registry menegakkan kontrak, Ajv strict mode, dan aturan kombinasi enum", () => {
  const reg = createCapabilityRegistry();

  // Kontrak wajib
  assert.throws(() => reg.registerCapability({ name: "missing_fields" }), /harus memiliki version/);

  // Enum risk tidak valid
  assert.throws(() => reg.registerCapability({
    name: "bad_risk",
    version: "1.0.0",
    description: "test",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "ultra_high",
    channelScopes: ["group"],
    handler: async () => {},
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "read_only",
  }), /Risk 'ultra_high' tidak valid/);

  // Aturan kombinasi: read_only tidak boleh memiliki sideEffect write/send/external
  assert.throws(() => reg.registerCapability({
    name: "bad_combination",
    version: "1.0.0",
    description: "test",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    handler: async () => {},
    verifier: async () => ({ ok: true }),
    sideEffect: "send",
    idempotency: "read_only",
  }), /Kombinasi tidak valid/);

  // Aturan kombinasi: sideEffect none tidak boleh non_idempotent
  assert.throws(() => reg.registerCapability({
    name: "bad_combination_2",
    version: "1.0.0",
    description: "test",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    handler: async () => {},
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "non_idempotent",
  }), /Kombinasi tidak valid/);
});

// ============================================================================
// 5. POLICY, SCOPES, & FAIL-CLOSED ACTOR VERIFICATION TESTS
// ============================================================================

test("Point B: policy menolak keras actor tanpa verified true dan provenance tidak valid", () => {
  const cap = {
    name: "test_cap",
    enabled: true,
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
  };

  // 1. verified missing (undefined)
  const r1 = authorize({
    actor: { pn: "628123456789", provenance: "test_harness" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r1.allow, false);
  assert.equal(r1.reasonCode, REASON_CODES.DENIED_UNVERIFIED_ACTOR);

  // 2. verified null
  const r2 = authorize({
    actor: { pn: "628123456789", verified: null, provenance: "test_harness" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r2.allow, false);
  assert.equal(r2.reasonCode, REASON_CODES.DENIED_UNVERIFIED_ACTOR);

  // 3. verified angka truthy (1) atau string ("true")
  const r3 = authorize({
    actor: { pn: "628123456789", verified: 1, provenance: "test_harness" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r3.allow, false);
  assert.equal(r3.reasonCode, REASON_CODES.DENIED_UNVERIFIED_ACTOR);

  const r4 = authorize({
    actor: { pn: "628123456789", verified: "true", provenance: "test_harness" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r4.allow, false);
  assert.equal(r4.reasonCode, REASON_CODES.DENIED_UNVERIFIED_ACTOR);

  // 4. verified: true, tapi tanpa provenance
  const r5 = authorize({
    actor: { pn: "628123456789", verified: true },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r5.allow, false);
  assert.equal(r5.reasonCode, REASON_CODES.DENIED_INVALID_PROVENANCE);

  // 5. verified: true, tapi provenance asal-asalan (injeksi)
  const r6 = authorize({
    actor: { pn: "628123456789", verified: true, provenance: "model_injected_prompt" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r6.allow, false);
  assert.equal(r6.reasonCode, REASON_CODES.DENIED_INVALID_PROVENANCE);

  // 6. Raw LID
  const r7 = authorize({
    actor: { pn: "123456789012345@lid", verified: true, provenance: "test_harness" },
    capability: cap,
    context: { channel: "group", activeScopes: ["group", "active_chat"] },
  });
  assert.equal(r7.allow, false);
  assert.equal(r7.reasonCode, REASON_CODES.DENIED_RAW_LID);
});

test("Point C: Pemisahan semantik scope (channel one-of, requiredScopes all-of, owner explicit)", () => {
  const reg = createCapabilityRegistry();
  reg.registerCapability({
    name: "group_send_tool",
    version: "1.0.0",
    description: "Kirim pesan di grup",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { sent: { type: "boolean" } },
      required: ["sent"],
      additionalProperties: false,
    },
    risk: "medium",
    channelScopes: ["group"],
    requiredScopes: ["active_chat", "send"],
    enabled: true,
    handler: async () => ({ sent: true }),
    verifier: async () => ({ ok: true }),
    sideEffect: "send",
    idempotency: "idempotent",
  });

  // 1. getToolDeclarations: jika hanya punya scope "group" tanpa "active_chat" dan "send", tool TIDAK terlihat
  const toolsPartial = reg.getToolDeclarations({
    channel: "group",
    activeScopes: ["group"],
    actor: VALID_ACTOR,
  });
  assert.equal(toolsPartial.length, 0, "Tool group_send_tool tidak boleh terekspos jika kekurangan requiredScopes");

  // 2. getToolDeclarations: terlihat hanya ketika semua requiredScopes terpenuhi
  const toolsFull = reg.getToolDeclarations({
    channel: "group",
    activeScopes: ["group", "active_chat", "send"],
    actor: VALID_ACTOR,
  });
  assert.equal(toolsFull.length, 1);
  assert.equal(toolsFull[0].function.name, "group_send_tool");

  // 3. executeCapability: jika hanya ada scope "group", eksekusi DITOLAK policy
  assert.rejects(
    async () => reg.executeCapability(
      "group_send_tool",
      { text: "tes" },
      {
        actor: VALID_ACTOR,
        channel: "group",
        activeScopes: ["group"],
        originChat: "group1@g.us",
      },
    ),
    (err) => {
      assert.equal(err.code, "policy_denied");
      assert.equal(err.details?.reasonCode, REASON_CODES.DENIED_INSUFFICIENT_SCOPES);
      return true;
    },
  );

  // 4. Channel mismatch: dijalankan di DM ditolak
  assert.rejects(
    async () => reg.executeCapability(
      "group_send_tool",
      { text: "tes" },
      {
        actor: VALID_ACTOR,
        channel: "dm",
        activeScopes: ["dm", "active_chat", "send"],
        originChat: "dm1@s.whatsapp.net",
      },
    ),
    (err) => {
      assert.equal(err.code, "policy_denied");
      assert.equal(err.details?.reasonCode, REASON_CODES.DENIED_CHANNEL_MISMATCH);
      return true;
    },
  );
});

// ============================================================================
// 6. INTEGRATED EXECUTION PIPELINE & HANDLER COUNTER TESTS
// ============================================================================

test("Point A: Handler counter tetap 0 pada seluruh kegagalan gate pipeline", async () => {
  const reg = createCapabilityRegistry();
  let handlerCallCount = 0;

  reg.registerCapability({
    name: "counter_tool",
    version: "1.0.0",
    description: "Tool uji coba dengan penghitung pemanggilan",
    inputSchema: {
      type: "object",
      properties: { num: { type: "number" } },
      required: ["num"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "number" } },
      required: ["result"],
      additionalProperties: false,
    },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat", "read"],
    enabled: true,
    handler: async (input) => {
      handlerCallCount++;
      return { result: input.num * 2 };
    },
    verifier: async (res) => ({ ok: typeof res?.result === "number" }),
    sideEffect: "none",
    idempotency: "read_only",
  });

  const validCtx = {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat", "read"],
    originChat: "group1@g.us",
  };

  // Gate 1: Capability disabled
  reg.disableCapability("counter_tool");
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, validCtx),
    (err) => err.code === "capability_disabled",
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat capability disabled");
  reg.enableCapability("counter_tool");

  // Gate 2: Input schema invalid
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: "bukan_angka" }, validCtx),
    (err) => err.code === "invalid_input",
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat input schema invalid");

  // Gate 3: Actor unverified
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, {
      ...validCtx,
      actor: { pn: "628123456789", verified: false, provenance: "test_harness" },
    }),
    (err) => err.code === "policy_denied" && err.details?.reasonCode === REASON_CODES.DENIED_UNVERIFIED_ACTOR,
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat actor unverified");

  // Gate 4: Insufficient scopes
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, {
      ...validCtx,
      activeScopes: ["group"], // kurang active_chat dan read
    }),
    (err) => err.code === "policy_denied" && err.details?.reasonCode === REASON_CODES.DENIED_INSUFFICIENT_SCOPES,
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat scope kurang");

  // Gate 5: Cross-chat attempt
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, {
      ...validCtx,
      destination: "other_group@g.us",
    }),
    (err) => err.code === "policy_denied" && err.details?.reasonCode === REASON_CODES.DENIED_CROSS_CHAT,
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat cross-chat");

  // Gate 6: Model-injected arbitrary destination in arguments
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, {
      ...validCtx,
      invocation: { arguments: { destination: "hack_target@g.us" } },
    }),
    (err) => err.code === "policy_denied" && err.details?.reasonCode === REASON_CODES.DENIED_ARBITRARY_DESTINATION,
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat model inject destination");

  // Gate 7: Budget exhausted
  const exhaustedBudget = new TaskBudget({ maxToolSteps: 0 });
  await assert.rejects(
    () => reg.executeCapability("counter_tool", { num: 5 }, {
      ...validCtx,
      budget: exhaustedBudget,
    }),
    (err) => err.code === "budget_exhausted",
  );
  assert.equal(handlerCallCount, 0, "Handler tidak boleh dipanggil saat budget habis");

  // Ketika seluruh gate valid: handler terpanggil tepat 1 kali
  const successRes = await reg.executeCapability("counter_tool", { num: 5 }, validCtx);
  assert.equal(successRes.ok, true);
  assert.equal(successRes.data.result, 10);
  assert.equal(handlerCallCount, 1, "Handler harus terpanggil tepat 1 kali saat seluruh gate lulus");
});

// ============================================================================
// 7. TIMEOUT, CANCELLATION, & COOPERATIVE SIGNAL TESTS
// ============================================================================

test("Point D: Timeout memicu AbortSignal dan handler cooperative tidak menjalankan efek samping tertunda", async () => {
  const reg = createCapabilityRegistry();
  let delayedSideEffectExecuted = false;

  reg.registerCapability({
    name: "slow_side_effect_tool",
    version: "1.0.0",
    description: "Tool lambat dengan side effect tertunda",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "high",
    channelScopes: ["group"],
    requiredScopes: ["active_chat", "send"],
    enabled: true,
    timeoutMs: 50, // batas waktu sangat singkat untuk uji timeout
    handler: async (_input, ctx) => {
      // Simulasi proses asinkron yang menunggu
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Handler cooperative: periksa apakah sudah dibatalkan sebelum menjalankan side effect
      if (ctx.signal?.aborted) {
        return {};
      }

      delayedSideEffectExecuted = true;
      return {};
    },
    verifier: async () => ({ ok: true }),
    sideEffect: "send",
    idempotency: "idempotent",
  });

  const slowTaskId = "task_slow_001";
  const slowStepId = "step_slow_001";
  const slowIdempotencyKey = buildIdempotencyKey({
    taskId: slowTaskId,
    capabilityName: "slow_side_effect_tool",
    logicalOperationId: slowStepId,
  });

  await assert.rejects(
    () => reg.executeCapability("slow_side_effect_tool", {}, {
      actor: VALID_ACTOR,
      channel: "group",
      activeScopes: ["group", "active_chat", "send"],
      originChatId: "group1@g.us",
      taskId: slowTaskId,
      stepId: slowStepId,
      idempotencyKey: slowIdempotencyKey,
    }),
    (err) => {
      assert.equal(err.code, "timeout");
      return true;
    },
  );

  // Tunggu agar promise setTimeout handler selesai
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(
    delayedSideEffectExecuted,
    false,
    "Efek samping tertunda tidak boleh dieksekusi setelah timeout memicu abort signal",
  );
});

// ============================================================================
// 8. BUDGET RESERVATION LEAK TESTS
// ============================================================================

test("Point G: Error, timeout, dan cancel tidak meninggalkan active reservation yang bocor", async () => {
  const reg = createCapabilityRegistry();
  const budget = new TaskBudget();

  reg.registerCapability({
    name: "faulty_tool",
    version: "1.0.0",
    description: "Tool yang sengaja melempar error",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat", "read"],
    enabled: true,
    timeoutMs: 50,
    handler: async () => {
      throw new Error("Simulated failure in handler");
    },
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "read_only",
  });

  const ctx = {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat", "read"],
    originChat: "group1@g.us",
    budget,
  };

  // Eksekusi melempar error
  await assert.rejects(
    () => reg.executeCapability("faulty_tool", {}, ctx),
    (err) => err.code === "execution_failed",
  );

  // Periksa active reservations
  assert.equal(budget.activeReservations.size, 0, "Tidak boleh ada reservasi aktif yang bocor setelah error");
  assert.equal(budget.reserved.toolSteps, 0, "reserved.toolSteps harus kembali ke 0");
});

test("TaskBudget mematuhi konfigurasi default Plan.md", () => {
  const b = new TaskBudget();
  assert.equal(b.limits.maxToolSteps, 8);
  assert.equal(b.limits.maxModelCalls, 12);
  assert.equal(b.limits.maxWallTimeMs, 180_000);
  assert.equal(b.limits.maxTokens, 16_000);
  assert.equal(b.limits.maxCostUsd, 0.05);
});

// ============================================================================
// 9. OBSERVABILITY & REDACTION TESTS
// ============================================================================

test("redactObject menyembunyikan API key, token, auth header, dan data URL base64", () => {
  const payload = {
    apiKey: "sk-or-v1-abcdef1234567890abcdef123456",
    authorization: "Bearer secret-token-value",
    media: "data:image/jpeg;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=",
    nested: {
      token: "secret-token-nested",
      text: "Hubungi sk-or-v1-abcdef1234567890abcdef123456 atau Bearer token123",
    },
  };

  const sanitized = redactObject(payload);
  assert.equal(sanitized.apiKey, "[REDACTED]");
  assert.equal(sanitized.authorization, "[REDACTED]");
  assert.match(sanitized.media, /REDACTED_DATA_URL/);
  assert.equal(sanitized.nested.token, "[REDACTED]");
  assert.doesNotMatch(sanitized.nested.text, /sk-or-v1-[A-Za-z0-9]+/);
  assert.doesNotMatch(sanitized.nested.text, /Bearer token123/);
});

test("traceLogger merekam event terstruktur ke in-memory sink tanpa CoT mentah", () => {
  const sink = new InMemorySink();
  const logger = createTraceLogger({ sink });

  logger.log({
    operation: "test_op",
    taskId: "task-001",
    model: "z-ai/glm-5.3-flash",
    metadata: {
      reasoning: "INTERNAL_COT_THAT_SHOULD_NEVER_BE_STORED",
      summary: "Aman",
    },
  });

  const events = sink.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "test_op");
  assert.equal(events[0].metadata?.reasoning, undefined, "Reasoning mentah wajib dihapus dari trace");
  assert.equal(events[0].metadata?.summary, "Aman");
});

// ============================================================================
// 10. DIRECT INTEGRATION & DM STYLE TESTS
// ============================================================================

test("processGroupMessage dengan video tidak crash dan tidak mengklaim menonton video", async () => {
  const mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/alpha/decisions") {
        res.end(JSON.stringify({
          answers: {
            action: { choice: "reply", confidence: 0.95 },
            gratitude_target: { choice: "not_gratitude", confidence: 0.99 },
          },
        }));
        return;
      }
      if (req.url === "/api/v1/chat/completions") {
        const parsed = JSON.parse(body);
        const lastMsg = parsed.messages.at(-1);
        let hasVideoUrl = false;
        if (Array.isArray(lastMsg.content)) {
          hasVideoUrl = lastMsg.content.some((part) => part.type === "video_url");
        }
        assert.equal(hasVideoUrl, false, "Tidak boleh mengirim video_url ke GLM pada mode fail-soft");

        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                text: "Video terlampir telah kuterima, tapi aku belum bisa menganalisis isi videonya ya.",
                reply_to_entry_id: null,
              }),
            },
          }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });

  const port = await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve(mockServer.address().port)));
  const oldBaseUrl = process.env.OPENROUTER_BASE_URL;
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldDebounce = process.env.AI_DEBOUNCE_MS;
  const oldVideoSupport = process.env.AI_PROVIDER_SUPPORTS_VIDEO;

  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.AI_DEBOUNCE_MS = "50";
  delete process.env.AI_PROVIDER_SUPPORTS_VIDEO;

  const sent = [];
  const fakeSock = {
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, ...content, options });
      return { key: { id: "sent-video-reply" } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  };

  try {
    const res = await groupAgent.processGroupMessage({
      sock: fakeSock,
      message: { key: { id: "msg-vid", remoteJid: "video-failsoft@g.us" } },
      groupId: "video-failsoft@g.us",
      senderId: "+62811112222",
      senderName: "Budi",
      text: "[mengirim video]",
      explicitMention: true,
      replyToBot: false,
      quotedText: "",
      media: { type: "video", dataUrl: "data:video/mp4;base64,QUJDREVGR0g=" },
    });

    assert.equal(res.action, "reply");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /belum bisa menganalisis isi video/);
  } finally {
    mockServer.close();
    if (oldBaseUrl) process.env.OPENROUTER_BASE_URL = oldBaseUrl; else delete process.env.OPENROUTER_BASE_URL;
    if (oldKey) process.env.OPENROUTER_API_KEY = oldKey; else delete process.env.OPENROUTER_API_KEY;
    if (oldDebounce) process.env.AI_DEBOUNCE_MS = oldDebounce; else delete process.env.AI_DEBOUNCE_MS;
    if (oldVideoSupport) process.env.AI_PROVIDER_SUPPORTS_VIDEO = oldVideoSupport; else delete process.env.AI_PROVIDER_SUPPORTS_VIDEO;
  }
});

test("simulator safety guard menolak berjalan jika mengarah ke file produksi", async () => {
  const scriptPath = path.resolve("./scripts/simulate-dm.js");
  const prodMem = path.resolve("./ai-memory.json");

  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath],
      {
        env: {
          ...process.env,
          AI_MEMORY_FILE: prodMem,
          ALLOW_PRODUCTION_SIMULATION: "false",
        },
      },
      (err, stdout, stderr) => {
        if (err && (stderr.includes("[SIMULATOR GUARD] DITOLAK") || stdout.includes("[SIMULATOR GUARD] DITOLAK"))) {
          resolve();
        } else {
          reject(new Error(`Simulator harus ditolak saat mengarah ke produksi. stdout: ${stdout}, stderr: ${stderr}`));
        }
      },
    );
  });
});

// ============================================================================
// 12. FINAL CORRECTIONS REGRESSION TESTS (A, B, C, D)
// ============================================================================

test("Point A: Handler non-cooperative selesai setelah parent abort, executeCapability menghasilkan cancelled dan verifier tidak dipanggil", async () => {
  const reg = createCapabilityRegistry();
  const budget = new TaskBudget();
  let verifierCalled = false;
  let handlerFinished = false;

  reg.registerCapability({
    name: "non_cooperative_tool",
    version: "1.0.0",
    description: "Tool non-cooperative yang mengabaikan signal",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { val: { type: "string" } }, required: ["val"], additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
    enabled: true,
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      handlerFinished = true;
      return { val: "late_result" };
    },
    verifier: async () => {
      verifierCalled = true;
      return { ok: true };
    },
    sideEffect: "none",
    idempotency: "read_only",
  });

  const parentController = new AbortController();
  const execPromise = reg.executeCapability("non_cooperative_tool", {}, {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat"],
    originChat: "group1@g.us",
    budget,
    signal: parentController.signal,
  });

  // Trigger parent abort setelah eksekusi dimulai
  setTimeout(() => parentController.abort(new Error("External task cancellation")), 20);

  await assert.rejects(
    () => execPromise,
    (err) => {
      assert.equal(err.code, "cancelled");
      return true;
    },
  );

  // Tunggu agar handler menyelesaikan pekerjaannya di background
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(handlerFinished, true, "Handler selesai di background");
  assert.equal(verifierCalled, false, "Verifier TIDAK boleh dipanggil karena eksekusi telah dibatalkan");
  assert.equal(budget.activeReservations.size, 0, "Reservasi budget tidak boleh bocor");
  assert.equal(budget.usage.toolSteps, 1, "Percobaan tool yang telah dimulai tetap dihitung 1 tool step");
});

test("Point B: Delapan eksekusi handler gagal menghabiskan maxToolSteps dan eksekusi kesembilan ditolak sebelum handler", async () => {
  const reg = createCapabilityRegistry();
  const budget = new TaskBudget({ maxToolSteps: 8 });
  let handlerInvocations = 0;

  reg.registerCapability({
    name: "failing_step_tool",
    version: "1.0.0",
    description: "Tool yang selalu gagal untuk uji kuota tool step",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
    enabled: true,
    handler: async () => {
      handlerInvocations++;
      throw new Error("Simulated failure in handler");
    },
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "read_only",
  });

  const ctx = {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat"],
    originChat: "group1@g.us",
    budget,
  };

  // Jalankan 8 kali: semuanya gagal di handler, masing-masing terhitung sebagai tool step
  for (let i = 0; i < 8; i++) {
    await assert.rejects(
      () => reg.executeCapability("failing_step_tool", {}, ctx),
      (err) => err.code === "execution_failed",
    );
  }

  assert.equal(handlerInvocations, 8);
  assert.equal(budget.usage.toolSteps, 8);
  assert.equal(budget.activeReservations.size, 0);

  // Panggilan ke-9: harus ditolak oleh budget sebelum handler dipanggil
  await assert.rejects(
    () => reg.executeCapability("failing_step_tool", {}, ctx),
    (err) => {
      assert.equal(err.code, "budget_exhausted");
      assert.equal(err.details?.reason, "tool_steps_exhausted");
      return true;
    },
  );

  // Handler call counter tetap tepat 8
  assert.equal(handlerInvocations, 8, "Handler tidak boleh dipanggil pada percobaan ke-9");
});

test("Point C: OpenRouter retry terhubung ke TaskBudget, maksimal 2 retry, invalid_request tidak di-retry", async () => {
  const budget = new TaskBudget({ maxRetries: 2 });
  let networkCalls = 0;

  const mockHttp = {
    post: async () => {
      networkCalls++;
      const err = new Error("Gateway Timeout 504");
      err.response = { status: 504, data: { message: "Gateway Timeout" } };
      throw err;
    },
  };

  const client = createOpenRouterClient({
    httpClient: mockHttp,
    maxRetries: 2,
    sleepFn: async () => {},
    onRetry: async () => {
      budget.recordRetry();
    },
  });

  // Request yang gagal transient: 1 initial call + 2 retries = 3 network calls
  await assert.rejects(
    () => client.request("/test-endpoint", {}),
    (err) => err.category === "provider_error" || err.category === "timeout",
  );

  assert.equal(networkCalls, 3, "Total panggilan: 1 awal + 2 percobaan ulang");
  assert.equal(budget.usage.retries, 2, "TaskBudget mencatat tepat 2 retries");

  // Jika dipanggil lagi dan mencoba retry ke-3, budget harus menolak
  const mockHttp3 = {
    post: async () => {
      const err = new Error("Gateway Timeout 504");
      err.response = { status: 504, data: { message: "Gateway Timeout" } };
      throw err;
    },
  };

  const client2 = createOpenRouterClient({
    httpClient: mockHttp3,
    maxRetries: 2,
    sleepFn: async () => {},
    onRetry: async () => {
      budget.recordRetry();
    },
  });

  await assert.rejects(
    () => client2.request("/test-endpoint", {}),
    (err) => {
      assert.equal(err.code, "budget_exhausted");
      assert.equal(err.reason, "retries_exhausted");
      return true;
    },
  );

  // Uji bahwa invalid_request tidak di-retry
  const mockHttpInvalid = {
    post: async () => {
      const err = new Error("Invalid request");
      err.response = { status: 400, data: { message: "Bad Schema" } };
      throw err;
    },
  };

  const freshBudget = new TaskBudget({ maxRetries: 2 });
  const clientInvalid = createOpenRouterClient({
    httpClient: mockHttpInvalid,
    maxRetries: 2,
    sleepFn: async () => {},
    onRetry: async () => {
      freshBudget.recordRetry();
    },
  });

  await assert.rejects(
    () => clientInvalid.request("/test-invalid", {}),
    (err) => err.category === "invalid_request",
  );

  assert.equal(freshBudget.usage.retries, 0, "invalid_request tidak boleh memicu onRetry atau menambah retries budget");
});

test("Point D: Capability side-effect wajib originChatId dan runtime idempotencyKey, model-injected target ditolak", async () => {
  const reg = createCapabilityRegistry();
  let sendHandlerCalls = 0;

  // 1. Registrasi sideEffect send dengan non_idempotent ditolak
  assert.throws(
    () => reg.registerCapability({
      name: "bad_send",
      version: "1.0.0",
      description: "Send non idempotent",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      risk: "high",
      channelScopes: ["group"],
      requiredScopes: ["active_chat", "send"],
      handler: async () => {},
      verifier: async () => ({ ok: true }),
      sideEffect: "send",
      idempotency: "non_idempotent",
    }),
    /Kombinasi tidak valid.*wajib memakai idempotency 'idempotent' atau 'transactional'/,
  );

  // 2. Registrasi capability send yang sah
  reg.registerCapability({
    name: "safe_send_message",
    version: "1.0.0",
    description: "Kirim pesan teks dengan proteksi idempotency",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        destination: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { success: { type: "boolean" } },
      required: ["success"],
      additionalProperties: false,
    },
    risk: "high",
    channelScopes: ["group"],
    requiredScopes: ["active_chat", "send"],
    enabled: true,
    handler: async () => {
      sendHandlerCalls++;
      return { success: true };
    },
    verifier: async (res) => ({ ok: res?.success === true }),
    sideEffect: "send",
    idempotency: "idempotent",
  });

  const baseCtx = {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat", "send"],
  };

  const taskId = "task1";
  const stepId = "step1";
  const exactKey = buildIdempotencyKey({
    taskId,
    capabilityName: "safe_send_message",
    logicalOperationId: stepId,
  });

  // Test missing originChatId
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      idempotencyKey: exactKey,
      taskId,
      stepId,
    }),
    (err) => err.code === "missing_origin_chat",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat originChatId hilang");

  // Test missing taskId
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      stepId,
      idempotencyKey: exactKey,
    }),
    (err) => err.code === "missing_task_id",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat taskId hilang");

  // Test missing stepId
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      taskId,
      idempotencyKey: exactKey,
    }),
    (err) => err.code === "missing_step_id",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat stepId hilang");

  // Test missing idempotencyKey
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      taskId,
      stepId,
    }),
    (err) => err.code === "missing_idempotency_key",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat idempotencyKey hilang");

  // Test rt_fake ditolak
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      taskId,
      stepId,
      idempotencyKey: "rt_fake",
    }),
    (err) => err.code === "invalid_idempotency_key",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat rt_fake digunakan");

  // Test key yang mengandung taskId sebagai substring ditolak
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      taskId,
      stepId,
      idempotencyKey: `custom_prefix_${taskId}_suffix`,
    }),
    (err) => err.code === "invalid_idempotency_key",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat substring taskId digunakan");

  // Test key milik task lain ditolak
  const otherTaskKey = buildIdempotencyKey({
    taskId: "other_task_999",
    capabilityName: "safe_send_message",
    logicalOperationId: stepId,
  });
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      taskId,
      stepId,
      idempotencyKey: otherTaskKey,
    }),
    (err) => err.code === "invalid_idempotency_key",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat key task lain digunakan");

  // Test model trying to pass idempotency key in input
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo", idempotencyKey: "model_injected_key" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      idempotencyKey: exactKey,
      taskId,
      stepId,
    }),
    (err) => err.code === "invalid_idempotency_key",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat model inject idempotencyKey");

  // Test model trying to pass destination in input arguments
  await assert.rejects(
    () => reg.executeCapability("safe_send_message", { text: "halo", destination: "group1@g.us" }, {
      ...baseCtx,
      originChatId: "group1@g.us",
      idempotencyKey: exactKey,
      taskId,
      stepId,
    }),
    (err) => err.code === "destination_injection_denied" || err.code === "policy_denied",
  );
  assert.equal(sendHandlerCalls, 0, "Handler tidak boleh dipanggil saat model inject destination");

  // Ketika originChatId dan exact runtime idempotencyKey valid: eksekusi sukses!
  const successRes = await reg.executeCapability("safe_send_message", { text: "halo" }, {
    ...baseCtx,
    originChatId: "group1@g.us",
    idempotencyKey: exactKey,
    taskId,
    stepId,
  });
  assert.equal(successRes.ok, true);
  assert.equal(sendHandlerCalls, 1, "Handler harus terpanggil tepat 1 kali");
});

test("Point K: Helper buildIdempotencyKey & verifyIdempotencyKey deterministik dan konsisten", () => {
  const key1 = buildIdempotencyKey({ taskId: "t1", capabilityName: "c1", logicalOperationId: "s1" });
  const key2 = buildIdempotencyKey({ taskId: "t1", capabilityName: "c1", logicalOperationId: "s1" });
  const keyDifferentTask = buildIdempotencyKey({ taskId: "t2", capabilityName: "c1", logicalOperationId: "s1" });
  const keyDifferentCap = buildIdempotencyKey({ taskId: "t1", capabilityName: "c2", logicalOperationId: "s1" });
  const keyDifferentStep = buildIdempotencyKey({ taskId: "t1", capabilityName: "c1", logicalOperationId: "s2" });

  assert.equal(key1, key2, "Derivasi harus deterministik");
  assert.notEqual(key1, keyDifferentTask);
  assert.notEqual(key1, keyDifferentCap);
  assert.notEqual(key1, keyDifferentStep);

  assert.equal(verifyIdempotencyKey(key1, { taskId: "t1", capabilityName: "c1", logicalOperationId: "s1" }), true);
  assert.equal(verifyIdempotencyKey(key1, { taskId: "t2", capabilityName: "c1", logicalOperationId: "s1" }), false);
  assert.equal(verifyIdempotencyKey("rt_fake", { taskId: "t1", capabilityName: "c1", logicalOperationId: "s1" }), false);
  assert.equal(verifyIdempotencyKey(`idemp_${key1}`, { taskId: "t1", capabilityName: "c1", logicalOperationId: "s1" }), false);

  assert.throws(() => buildIdempotencyKey({ capabilityName: "c1", logicalOperationId: "s1" }), /taskId atau correlationId wajib non-empty/);
  assert.throws(() => buildIdempotencyKey({ taskId: "t1", logicalOperationId: "s1" }), /capabilityName wajib non-empty/);
  assert.throws(() => buildIdempotencyKey({ taskId: "t1", capabilityName: "c1" }), /logicalOperationId atau stepId wajib non-empty/);
});

test("Point L: Parent abort listener wajib dilepas setelah executeCapability selesai", async () => {
  const reg = createCapabilityRegistry();
  reg.registerCapability({
    name: "listener_test_tool",
    version: "1.0.0",
    description: "Tool uji pembersihan listener",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
    enabled: true,
    handler: async () => ({ ok: true }),
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "read_only",
  });

  const parentController = new AbortController();
  assert.equal(EventEmitter.listenerCount(parentController.signal, "abort"), 0);

  const res = await reg.executeCapability("listener_test_tool", {}, {
    actor: VALID_ACTOR,
    channel: "group",
    activeScopes: ["group", "active_chat"],
    originChat: "group1@g.us",
    signal: parentController.signal,
  });
  assert.equal(res.ok, true);
  assert.equal(EventEmitter.listenerCount(parentController.signal, "abort"), 0, "Abort listener harus 0 setelah selesai");
});

test("Point M: Handler terlambat yang melempar error tidak memicu unhandled rejection", async () => {
  const reg = createCapabilityRegistry();
  let lateHandlerRan = false;

  reg.registerCapability({
    name: "late_error_tool",
    version: "1.0.0",
    description: "Tool yang throw error setelah timeout",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
    enabled: true,
    timeoutMs: 30,
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      lateHandlerRan = true;
      throw new Error("Late unhandled boom");
    },
    verifier: async () => ({ ok: true }),
    sideEffect: "none",
    idempotency: "read_only",
  });

  const unhandledRejections = [];
  const onUnhandled = (reason) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    await assert.rejects(
      () => reg.executeCapability("late_error_tool", {}, {
        actor: VALID_ACTOR,
        channel: "group",
        activeScopes: ["group", "active_chat"],
        originChat: "group1@g.us",
      }),
      (err) => err.code === "timeout",
    );

    // Tunggu sampai handler selesai melempar error di background
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(lateHandlerRan, true, "Handler harus berjalan sampai akhir di background");
    assert.equal(unhandledRejections.length, 0, "Tidak boleh ada unhandledRejection dari handler terlambat");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("Point N: Budget reconciliation hanya terjadi tepat 1 kali", async () => {
  const reg = createCapabilityRegistry();
  const budget = new TaskBudget();
  let reconcileCallCount = 0;
  const originalReconcile = budget.reconcile.bind(budget);
  budget.reconcile = (reservationId, details) => {
    reconcileCallCount++;
    return originalReconcile(reservationId, details);
  };

  reg.registerCapability({
    name: "single_reconcile_tool",
    version: "1.0.0",
    description: "Tool untuk uji single reconciliation",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    risk: "low",
    channelScopes: ["group"],
    requiredScopes: ["active_chat"],
    enabled: true,
    handler: async () => ({ ok: true }),
    verifier: async () => {
      throw new Error("Verifier intentional failure");
    },
    sideEffect: "none",
    idempotency: "read_only",
  });

  await assert.rejects(
    () => reg.executeCapability("single_reconcile_tool", {}, {
      actor: VALID_ACTOR,
      channel: "group",
      activeScopes: ["group", "active_chat"],
      originChat: "group1@g.us",
      budget,
    }),
    (err) => err.code === "verification_failed",
  );

  assert.equal(reconcileCallCount, 1, "Budget reconcile harus dipanggil tepat 1 kali");
  assert.equal(budget.activeReservations.size, 0, "Semua reservasi harus telah diselesaikan");
  assert.equal(budget.usage.toolSteps, 1, "Tool step tetap terhitung");
});

test("Point O: Dua subprocess dapat menulis state memori secara konkuren tanpa collision rename temp", async () => {
  const runSubprocess = (suiteId) => {
    return new Promise((resolve, reject) => {
      const code = `
        const fs = require("node:fs");
        const os = require("node:os");
        const path = require("node:path");

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-concurrent-${suiteId}-"));
        process.env.AI_MEMORY_FILE = path.join(tempDir, "ai-memory.json");
        process.env.AGENT_JOBS_FILE = path.join(tempDir, "agent-jobs.json");
        process.env.BOT_DATA_FILE = path.join(tempDir, "data.json");

        const memoryStore = require("./ai/memory-store");
        const scheduler = require("./ai/scheduler");

        try {
          for (let i = 0; i < 30; i++) {
            memoryStore.recordParticipant({ phone: "628100" + ${suiteId} + i, name: "User" + i, groupId: "group" + ${suiteId} + "@g.us" });
            memoryStore.upsertPersonProfile("628100" + ${suiteId} + i, { profile: "profile " + i });
            memoryStore.setGroupMemory("group" + ${suiteId} + "@g.us", { glm: "glm " + i });
            scheduler.scheduleJob({ type: "reminder", fire_at: Date.now() + 100000, payload: { target: "628100" + ${suiteId} + i } });
          }
          const loaded = JSON.parse(fs.readFileSync(process.env.AI_MEMORY_FILE, "utf8"));
          if (!loaded.people || Object.keys(loaded.people).length !== 30) {
            throw new Error("Gagal verifikasi data people di memori");
          }
          fs.rmSync(tempDir, { recursive: true, force: true });
          process.exit(0);
        } catch (err) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          console.error(err);
          process.exit(1);
        }
      `;
      execFile(process.execPath, ["-e", code], { cwd: path.resolve(".") }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Subprocess ${suiteId} gagal: ${stderr || stdout || err.message}`));
        } else {
          resolve();
        }
      });
    });
  };

  await Promise.all([runSubprocess(1), runSubprocess(2)]);
});
