/**
 * Task Planner (GLM Flash) untuk Runtime Otonom (Fase 3)
 *
 * Persyaratan:
 * 1. Hanya menggunakan provider GLM Flash Fase 1 (ai/providers/glm-client.js).
 * 2. Strict structured JSON schema tervalidasi Ajv (strict mode).
 * 3. Batas ketat ukuran rencana: maksimal 8 langkah per task (Plan.md).
 * 4. Prompt planner TIDAK memuat rahasia, raw media/data URL base64, auth, atau chain-of-thought.
 * 5. Model output TIDAK BOLEH memilih policy, approvals, identity, atau menulis ke DB langsung.
 * 6. Model output dilarang menyuntikkan destination, recipient, atau idempotencyKey.
 */

const Ajv = require("ajv");
const { createGlmClient } = require("../providers/glm-client");
const { redactObject } = require("../observability/redact");

const ajv = new Ajv({ allErrors: true, strict: true });

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    plan_id: { type: "string", minLength: 1, maxLength: 64 },
    goal: { type: "string", minLength: 1, maxLength: 500 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          step_index: { type: "integer", minimum: 0, maximum: 7 },
          capability_name: { type: "string", minLength: 1, maxLength: 64 },
          logical_operation_id: { type: "string", minLength: 1, maxLength: 64 },
          arguments: { type: "object" },
          expected_result: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["step_index", "capability_name", "logical_operation_id", "arguments", "expected_result"],
        additionalProperties: false,
      },
    },
    final_response: { type: "string", maxLength: 1000 },
  },
  required: ["plan_id", "goal", "steps"],
  additionalProperties: false,
};

const validatePlanSchema = ajv.compile(PLAN_SCHEMA);

class PlannerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PlannerError";
    this.code = details.code || "planner_error";
    this.details = details;
  }
}

class TaskPlanner {
  constructor({
    glmClient = null,
    model = process.env.CHAT_MODEL || "z-ai/glm-5.3-flash",
    reasoningEffort = "low",
  } = {}) {
    this.glmClient = glmClient || createGlmClient();
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  /**
   * Menghasilkan rencana langkah terstruktur tervalidasi Ajv untuk sebuah task
   */
  async generatePlan({
    goal,
    chatId,
    actorPn,
    channel = "group",
    availableCapabilities = [],
    historySummary = null,
    contextEpoch = 0,
  }) {
    if (!goal || typeof goal !== "string" || !goal.trim()) {
      throw new PlannerError("Goal wajib non-empty string", { code: "invalid_goal" });
    }

    // 1. Sanitasi dan proteksi prompt: tidak ada secret, auth, raw media, atau CoT
    const sanitizedGoal = String(goal).slice(0, 1000);
    const sanitizedHistory = historySummary ? String(historySummary).slice(0, 2000) : "";

    const toolSummaries = availableCapabilities.map((c) => ({
      name: c.name,
      description: c.description,
      parameters: c.inputSchema,
    }));

    const systemPrompt = [
      "You are an autonomous task planner for an AI assistant.",
      "Plan the task as a sequence of discrete bounded steps using ONLY the available capabilities.",
      "Rules:",
      "1. You must output ONLY a valid JSON object matching the requested schema.",
      "2. Maximum 8 steps. Keep plans concise, bounded, and deterministic.",
      "3. Step indices must be 0, 1, 2, ... in order.",
      "4. Do NOT include 'destination', 'target', 'to', or 'idempotencyKey' in step arguments; destination and idempotency are strictly managed by runtime security.",
      "5. You cannot grant permissions, change policies, or select identity.",
      "6. Each step must have a unique logical_operation_id.",
      "7. For make_sticker after a media-fetch step, set asset_id to the exact string '$last_asset'; runtime resolves it from the last verified asset in this task. Never invent an asset ID.",
      "8. For send_asset after make_sticker, set asset_id to '$last_asset' and mode to 'sticker'. Never choose a destination; runtime sends only to the origin chat.",
    ].join("\n");

    const userPrompt = JSON.stringify(
      redactObject({
        task_goal: sanitizedGoal,
        chat_id: chatId,
        channel,
        context_epoch: contextEpoch,
        history_context: sanitizedHistory,
        available_tools: toolSummaries,
      }),
    );

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Rencanakan langkah terstruktur untuk goal berikut:\n${userPrompt}` },
    ];

    // 2. Pemanggilan GLM Flash dengan JSON Schema Response Format
    let response;
    try {
      response = await this.glmClient.chatCompletion({
        model: this.model,
        messages,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "task_execution_plan",
            strict: true,
            schema: PLAN_SCHEMA,
          },
        },
        maxTokens: 1000,
        temperature: 0.1,
        reasoningEffort: this.reasoningEffort,
      });
    } catch (err) {
      throw new PlannerError(`Panggilan GLM Flash planner gagal: ${err.message}`, {
        code: "planner_network_error",
        cause: err,
      });
    }

    // 3. Parse JSON output
    let planData;
    try {
      const rawText = String(response.text || "").trim();
      // Bersihkan kemungkinan pembungkus markdown ```json
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      planData = JSON.parse(cleaned);
    } catch (err) {
      throw new PlannerError("GLM Flash menghasilkan output JSON yang rusak atau tidak dapat di-parse", {
        code: "bad_planner_json",
        raw: response.text,
      });
    }

    // 4. Validasi skema ketat Ajv
    const valid = validatePlanSchema(planData);
    if (!valid) {
      const errors = validatePlanSchema.errors || [];
      const errorMsg = errors
        .map((e) => `${e.instancePath || "root"} ${e.message}`)
        .join("; ");
      throw new PlannerError(`Validasi skema Ajv untuk rencana gagal: ${errorMsg}`, {
        code: "invalid_plan_schema",
        errors,
      });
    }

    // 5. Anti-injection and semantic validation
    this._validatePlanSemantics(planData, availableCapabilities);

    return {
      plan: planData,
      usage: response.usage,
      latencyMs: response.latencyMs,
    };
  }

  _validatePlanSemantics(plan, availableCapabilities = []) {
    const knownCapabilities = new Set(availableCapabilities.map((c) => c.name));
    const seenOpIds = new Set();

    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new PlannerError("Rencana tidak memuat langkah eksekusi", { code: "empty_steps" });
    }

    if (plan.steps.length > 8) {
      throw new PlannerError(`Jumlah langkah (${plan.steps.length}) melebihi batas maksimum 8`, {
        code: "plan_step_count_exceeded",
      });
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.capability_name === "send_asset" && (i !== plan.steps.length - 1 || plan.steps.filter((item) => item.capability_name === "send_asset").length !== 1)) {
        throw new PlannerError("send_asset harus satu kali dan menjadi langkah terakhir", { code: "invalid_send_asset_position" });
      }

      // Indeks berurut
      if (step.step_index !== i) {
        throw new PlannerError(`step_index tidak berurut: indeks ${step.step_index} pada posisi ${i}`, {
          code: "invalid_step_indexing",
        });
      }

      // Logical operation ID harus unik
      if (seenOpIds.has(step.logical_operation_id)) {
        throw new PlannerError(`Duplikasi logical_operation_id: '${step.logical_operation_id}'`, {
          code: "duplicate_operation_id",
        });
      }
      seenOpIds.add(step.logical_operation_id);

      // Capability wajib dikenal bila daftar capability diberikan
      if (knownCapabilities.size > 0 && !knownCapabilities.has(step.capability_name)) {
        throw new PlannerError(
          `Capability '${step.capability_name}' tidak terdaftar atau tidak diizinkan untuk task ini`,
          { code: "unknown_capability", capabilityName: step.capability_name },
        );
      }

      // Deteksi upaya injeksi model pada argumen
      const args = step.arguments || {};
      const forbiddenKeys = [
        "destination",
        "target",
        "recipient",
        "to",
        "idempotencyKey",
        "idempotency_key",
        "policy",
        "approval",
        "actor",
        "identity",
        "scope",
      ];

      for (const k of forbiddenKeys) {
        if (args[k] !== undefined) {
          throw new PlannerError(
            `Injeksi parameter terlarang dideteksi pada argumen model: '${k}' dilarang`,
            { code: "model_injection_detected", forbiddenKey: k },
          );
        }
      }
    }
  }
}

module.exports = {
  TaskPlanner,
  PlannerError,
  PLAN_SCHEMA,
};
