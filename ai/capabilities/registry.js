const crypto = require("crypto");
const Ajv = require("ajv");
const { SCOPES, isChannelScope, isPermissionScope, isValidScope } = require("../policy/scopes");
const { authorize, REASON_CODES } = require("../policy/authorize");

const ajv = new Ajv({ allErrors: true, strict: true });

const VALID_RISKS = Object.freeze(new Set(["low", "medium", "high", "critical"]));
const VALID_SIDE_EFFECTS = Object.freeze(new Set(["none", "read", "write", "send", "external"]));
const VALID_IDEMPOTENCY = Object.freeze(new Set(["read_only", "idempotent", "transactional", "non_idempotent"]));

/**
 * Membangun idempotency key secara deterministik dari:
 * - taskId atau correlationId
 * - capabilityName
 * - logicalOperationId atau stepId
 */
function buildIdempotencyKey(params = {}) {
  let taskId, correlationId, capabilityName, logicalOperationId, stepId;
  if (typeof params === "string") {
    taskId = arguments[0];
    capabilityName = arguments[1];
    logicalOperationId = arguments[2];
  } else if (params && typeof params === "object") {
    ({ taskId, correlationId, capabilityName, logicalOperationId, stepId } = params);
  }

  const effectiveTaskId = String(taskId || correlationId || "").trim();
  const effectiveCap = String(capabilityName || "").trim();
  const effectiveStep = String(logicalOperationId || stepId || "").trim();

  if (!effectiveTaskId) {
    throw new Error("taskId atau correlationId wajib non-empty untuk membangun idempotencyKey");
  }
  if (!effectiveCap) {
    throw new Error("capabilityName wajib non-empty untuk membangun idempotencyKey");
  }
  if (!effectiveStep) {
    throw new Error("logicalOperationId atau stepId wajib non-empty untuk membangun idempotencyKey");
  }

  const hash = crypto
    .createHash("sha256")
    .update(`${effectiveTaskId}:${effectiveCap}:${effectiveStep}`)
    .digest("hex");
  return `idemp_${hash.slice(0, 32)}`;
}

/**
 * Memverifikasi apakah idempotencyKey sesuai dengan derivasi deterministik.
 * Menolak pencocokan longgar (prefix rt_, runtime_, idemp_ atau substring match).
 */
function verifyIdempotencyKey(key, params = {}) {
  if (!key || typeof key !== "string") return false;
  try {
    let normalizedParams = params;
    if (typeof params === "string") {
      normalizedParams = {
        taskId: arguments[1],
        capabilityName: arguments[2],
        logicalOperationId: arguments[3],
      };
    }
    const expected = buildIdempotencyKey(normalizedParams);
    return key === expected;
  } catch {
    return false;
  }
}

function formatErrorsForModel(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) return "Validasi argumen gagal";
  return errors
    .map((e) => {
      const path = e.instancePath ? `argumen${e.instancePath}` : "argumen";
      return `${path} ${e.message}`;
    })
    .join("; ");
}

function sanitizeCause(err) {
  if (!err || typeof err !== "object") return null;
  return {
    name: err.name || "Error",
    message: String(err.message || "").slice(0, 300),
    code: err.code || null,
  };
}

class CapabilityExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CapabilityExecutionError";
    this.code = code;
    this.details = details;
  }
}

function createCapabilityRegistry() {
  const capabilities = new Map();

  function registerCapability(definition = {}) {
    const name = String(definition.name || "").trim();
    if (!name) throw new Error("Capability harus memiliki nama");
    if (capabilities.has(name)) throw new Error(`Capability sudah terdaftar: ${name}`);

    const version = String(definition.version || "").trim();
    if (!version) throw new Error(`Capability '${name}' harus memiliki version`);

    const description = String(definition.description || "").trim();
    if (!description) throw new Error(`Capability '${name}' harus memiliki description`);

    if (!definition.inputSchema || typeof definition.inputSchema !== "object") {
      throw new Error(`Capability '${name}' harus memiliki inputSchema JSON Schema yang valid`);
    }

    if (!definition.outputSchema || typeof definition.outputSchema !== "object") {
      throw new Error(`Capability '${name}' harus memiliki outputSchema JSON Schema yang valid`);
    }

    const risk = String(definition.risk || "").toLowerCase();
    if (!VALID_RISKS.has(risk)) {
      throw new Error(`Risk '${risk}' tidak valid untuk capability '${name}' (pilihan: low, medium, high, critical)`);
    }

    // Pemisahan channelScopes dan requiredScopes
    let channelScopes = Array.isArray(definition.channelScopes) ? [...definition.channelScopes] : [];
    let requiredScopes = Array.isArray(definition.requiredScopes) ? [...definition.requiredScopes] : [];

    // Kompatibilitas jika hanya menyediakan allowedScopes
    if (channelScopes.length === 0 && requiredScopes.length === 0 && Array.isArray(definition.allowedScopes)) {
      channelScopes = definition.allowedScopes.filter((s) => isChannelScope(s));
      requiredScopes = definition.allowedScopes.filter((s) => !isChannelScope(s));
    }

    if (channelScopes.length === 0) {
      throw new Error(`Capability '${name}' harus memiliki minimal satu channelScope (group, dm)`);
    }

    for (const ch of channelScopes) {
      if (!isChannelScope(ch)) {
        throw new Error(`Channel scope '${ch}' pada capability '${name}' tidak valid (harus group atau dm)`);
      }
    }

    for (const req of requiredScopes) {
      if (!isPermissionScope(req)) {
        throw new Error(`Required scope '${req}' pada capability '${name}' tidak valid`);
      }
    }

    if (typeof definition.handler !== "function") {
      throw new Error(`Capability '${name}' harus memiliki fungsi handler`);
    }

    if (typeof definition.verifier !== "function") {
      throw new Error(`Capability '${name}' harus memiliki fungsi verifier`);
    }

    const sideEffect = String(definition.sideEffect || "").toLowerCase();
    if (!VALID_SIDE_EFFECTS.has(sideEffect)) {
      throw new Error(`SideEffect '${sideEffect}' tidak valid untuk '${name}' (pilihan: none, read, write, send, external)`);
    }

    const idempotency = String(definition.idempotency || "").toLowerCase();
    if (!VALID_IDEMPOTENCY.has(idempotency)) {
      throw new Error(`Idempotency '${idempotency}' tidak valid untuk '${name}' (pilihan: read_only, idempotent, transactional, non_idempotent)`);
    }

    // Aturan kombinasi sideEffect dan idempotency
    if (idempotency === "read_only" && (sideEffect === "write" || sideEffect === "send" || sideEffect === "external")) {
      throw new Error(`Kombinasi tidak valid untuk '${name}': idempotency 'read_only' tidak boleh memiliki sideEffect '${sideEffect}'`);
    }
    if ((sideEffect === "none" || sideEffect === "read") && (idempotency === "non_idempotent")) {
      throw new Error(`Kombinasi tidak valid untuk '${name}': sideEffect '${sideEffect}' tidak boleh memiliki idempotency 'non_idempotent'`);
    }

    // Capability send atau external wajib memakai idempotency transactional atau idempotent
    if ((sideEffect === "send" || sideEffect === "external") && (idempotency === "non_idempotent" || idempotency === "read_only")) {
      throw new Error(`Kombinasi tidak valid untuk '${name}': sideEffect '${sideEffect}' wajib memakai idempotency 'idempotent' atau 'transactional'`);
    }

    // Kompilasi skema dengan Ajv strict mode saat registrasi
    let validateInput;
    let validateOutput;
    try {
      validateInput = ajv.compile(definition.inputSchema);
    } catch (err) {
      throw new Error(`Kompilasi inputSchema gagal untuk capability '${name}': ${err.message}`);
    }

    try {
      validateOutput = ajv.compile(definition.outputSchema);
    } catch (err) {
      throw new Error(`Kompilasi outputSchema gagal untuk capability '${name}': ${err.message}`);
    }

    const timeoutMs = Number.isInteger(definition.timeoutMs) && definition.timeoutMs > 0
      ? definition.timeoutMs
      : 20_000;

    const stored = {
      name,
      version,
      description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      risk,
      channelScopes,
      requiredScopes,
      allowedScopes: [...channelScopes, ...requiredScopes],
      enabled: Boolean(definition.enabled ?? false),
      timeoutMs,
      handler: definition.handler,
      verifier: definition.verifier,
      sideEffect,
      idempotency,
      validateInput,
      validateOutput,
    };

    capabilities.set(name, stored);
    return stored;
  }

  function getCapability(name) {
    return capabilities.get(String(name)) || null;
  }

  function listCapabilities({ channel = null, scope = null, enabledOnly = false } = {}) {
    const all = [...capabilities.values()];
    return all.filter((cap) => {
      if (enabledOnly && !cap.enabled) return false;
      if (channel && !cap.channelScopes.includes(channel)) return false;
      if (scope && !cap.allowedScopes.includes(scope)) return false;
      return true;
    });
  }

  function enableCapability(name) {
    const cap = capabilities.get(String(name));
    if (!cap) throw new Error(`Capability tidak ditemukan: ${name}`);
    cap.enabled = true;
    return cap;
  }

  function disableCapability(name) {
    const cap = capabilities.get(String(name));
    if (!cap) throw new Error(`Capability tidak ditemukan: ${name}`);
    cap.enabled = false;
    return cap;
  }

  function clearCapabilities() {
    capabilities.clear();
  }

  function getToolDeclarations(context = {}) {
    const channel = context.channel || context.activeChannel || null;
    const activeScopes = Array.isArray(context.activeScopes) ? context.activeScopes : [];
    const actor = context.actor || null;

    const activeCapabilities = listCapabilities({ enabledOnly: true });
    const declarations = [];

    for (const cap of activeCapabilities) {
      if (channel && !cap.channelScopes.includes(channel)) {
        continue;
      }

      const hasAllRequired = cap.requiredScopes.every((s) => activeScopes.includes(s));
      if (!hasAllRequired) {
        continue;
      }

      if (cap.requiredScopes.includes(SCOPES.OWNER)) {
        if (!actor || !actor.isOwner) {
          continue;
        }
      }

      declarations.push({
        type: "function",
        function: {
          name: cap.name,
          description: cap.description,
          parameters: cap.inputSchema,
        },
      });
    }

    return declarations;
  }

  async function executeCapability(name, input, context = {}) {
    // 1. Resolve registered capability
    const cap = getCapability(name);
    if (!cap) {
      throw new CapabilityExecutionError("capability_not_found", `Capability tidak ditemukan: ${name}`);
    }

    // 2. Enabled check
    if (!cap.enabled) {
      throw new CapabilityExecutionError("capability_disabled", `Capability '${name}' sedang dinonaktifkan`);
    }

    // 3. Deteksi injeksi model pada input argumen sebelum eksekusi & schema
    if (input && (input.idempotencyKey !== undefined || input.idempotency_key !== undefined)) {
      throw new CapabilityExecutionError(
        "invalid_idempotency_key",
        "Idempotency key dari model/input dilarang; harus dibentuk oleh runtime",
      );
    }
    if (cap.sideEffect === "send" && input && (input.destination !== undefined || input.target !== undefined || input.recipient !== undefined || input.to !== undefined)) {
      throw new CapabilityExecutionError(
        "destination_injection_denied",
        "Model dilarang menentukan destination/target pada capability send; tujuan hanya dikelola oleh runtime",
      );
    }

    // 4. Input schema validation
    const isInputValid = cap.validateInput(input);
    if (!isInputValid) {
      const reason = formatErrorsForModel(cap.validateInput.errors);
      throw new CapabilityExecutionError("invalid_input", `Argumen untuk capability '${name}' tidak valid: ${reason}`, {
        errors: cap.validateInput.errors,
      });
    }

    // 5. Policy Authorize
    const activeChannel = context.activeChannel || context.channel || null;
    const originChatId = String(context.originChatId || context.originChat || "").trim();
    const runtimeDestination = context.destination ? String(context.destination).trim() : originChatId;
    const authResult = authorize({
      actor: context.actor,
      capability: cap,
      context: {
        channel: activeChannel,
        activeScopes: context.activeScopes || [],
        originChatId,
      },
      invocation: context.invocation || {
        destination: runtimeDestination,
        arguments: input,
      },
    });

    if (!authResult.allow) {
      throw new CapabilityExecutionError(
        "policy_denied",
        `Eksekusi capability '${name}' ditolak policy: ${authResult.message}`,
        { reasonCode: authResult.reasonCode },
      );
    }

    // 6. Prakondisi sideEffect write/send/external & larangan model idempotency key
    if (cap.sideEffect === "write" || cap.sideEffect === "send" || cap.sideEffect === "external") {
      if (!originChatId) {
        throw new CapabilityExecutionError(
          "missing_origin_chat",
          `Capability side-effect '${name}' mewajibkan originChatId yang valid dari runtime`,
        );
      }

      const taskId = String(context.taskId || context.correlationId || "").trim();
      if (!taskId) {
        throw new CapabilityExecutionError(
          "missing_task_id",
          `Capability side-effect '${name}' mewajibkan taskId atau correlationId yang non-empty`,
        );
      }

      const logicalOperationId = String(context.logicalOperationId || context.stepId || "").trim();
      if (!logicalOperationId) {
        throw new CapabilityExecutionError(
          "missing_step_id",
          `Capability side-effect '${name}' mewajibkan logicalOperationId atau stepId eksplisit`,
        );
      }

      const idempotencyKey = String(context.idempotencyKey || "").trim();
      if (!idempotencyKey) {
        throw new CapabilityExecutionError(
          "missing_idempotency_key",
          `Capability side-effect '${name}' mewajibkan idempotencyKey dari runtime`,
        );
      }

      const isKeyValid = verifyIdempotencyKey(idempotencyKey, {
        taskId,
        capabilityName: name,
        logicalOperationId,
      });

      if (!isKeyValid) {
        throw new CapabilityExecutionError(
          "invalid_idempotency_key",
          `Idempotency key '${idempotencyKey}' tidak valid untuk capability '${name}', task '${taskId}', step '${logicalOperationId}'`,
        );
      }

      // Khusus capability send: destinasi hanya dari runtime dan harus sama dengan origin chat
      if (cap.sideEffect === "send") {
        if (runtimeDestination && originChatId && runtimeDestination !== originChatId) {
          throw new CapabilityExecutionError(
            "destination_mismatch",
            `Destination '${runtimeDestination}' tidak cocok dengan originChatId '${originChatId}'`,
          );
        }
      }
    }

    // 7. Budget reservation (sebelum handler dimulai)
    let reservationId = null;
    if (context.budget && typeof context.budget.reserve === "function") {
      try {
        reservationId = await context.budget.reserve({ type: "tool" });
      } catch (err) {
        throw new CapabilityExecutionError("budget_exhausted", err.message, { code: err.code, reason: err.reason });
      }
    }

    let reconciled = false;
    const doReconcile = (details) => {
      if (reconciled) return;
      reconciled = true;
      if (reservationId && context.budget && typeof context.budget.reconcile === "function") {
        try {
          const recPromise = context.budget.reconcile(reservationId, details);
          if (recPromise && typeof recPromise.catch === "function") {
            recPromise.catch(() => {});
          }
        } catch {}
      }
    };

    // Mulai dari titik ini: HANDLER AKAN MULAI. Setiap percobaan yang mulai wajib dihitung sebagai tool step.
    const abortController = new AbortController();
    const { signal } = abortController;

    let cancelListener = null;
    let timer = null;

    const cleanupResources = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (context.signal && cancelListener) {
        try {
          context.signal.removeEventListener("abort", cancelListener);
        } catch {}
        cancelListener = null;
      }
    };

    try {
      // Cancellation race: tangani parent signal yang abort saat eksekusi berjalan
      const cancellationPromise = new Promise((_, reject) => {
        if (context.signal) {
          if (context.signal.aborted) {
            const cancelErr = new CapabilityExecutionError(
              "cancelled",
              `Eksekusi capability '${name}' dibatalkan sebelum dimulai: ${context.signal.reason?.message || "Signal aborted"}`,
            );
            abortController.abort(cancelErr);
            reject(cancelErr);
            return;
          }

          cancelListener = () => {
            const cancelErr = new CapabilityExecutionError(
              "cancelled",
              `Eksekusi capability '${name}' dibatalkan oleh parent signal: ${context.signal.reason?.message || "Signal aborted"}`,
            );
            abortController.abort(cancelErr);
            reject(cancelErr);
          };
          context.signal.addEventListener("abort", cancelListener, { once: true });
        }
      });

      const executionContext = {
        ...context,
        signal,
        activeChannel,
        originChatId,
      };

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new CapabilityExecutionError(
            "timeout",
            `Eksekusi capability '${name}' melebihi batas waktu ${cap.timeoutMs}ms`,
          );
          abortController.abort(timeoutErr);
          reject(timeoutErr);
        }, cap.timeoutMs);
      });

      let rawResult;
      try {
        // Wrap handler execution dan pasang catch tanpa operasi agar handler yang gagal/reject terlambat
        // tidak memicu UnhandledPromiseRejection setelah timeout/cancellation
        const handlerPromise = Promise.resolve().then(() => cap.handler(input, executionContext));
        handlerPromise.catch(() => {});

        // Race mencakup handlerPromise, timeoutPromise, dan cancellationPromise
        rawResult = await Promise.race([
          handlerPromise,
          timeoutPromise,
          cancellationPromise,
        ]);
      } catch (err) {
        // Rekonsiliasi percobaan tool yang gagal/timeout/cancelled agar tetap terhitung sebagai 1 tool step
        doReconcile();
        if (err instanceof CapabilityExecutionError) throw err;
        const errCode = signal.aborted ? (signal.reason?.code || "cancelled") : "execution_failed";
        throw new CapabilityExecutionError(errCode, err.message, { cause: sanitizeCause(err) });
      } finally {
        cleanupResources();
      }

      // 8. Output schema validation
      const isOutputValid = cap.validateOutput(rawResult);
      if (!isOutputValid) {
        doReconcile();
        const reason = formatErrorsForModel(cap.validateOutput.errors);
        throw new CapabilityExecutionError(
          "invalid_output",
          `Output capability '${name}' tidak memenuhi outputSchema: ${reason}`,
          { errors: cap.validateOutput.errors },
        );
      }

      // 9. Verifier
      let verifyResult;
      try {
        verifyResult = await cap.verifier(rawResult, executionContext);
      } catch (err) {
        doReconcile();
        throw new CapabilityExecutionError("verification_failed", `Verifier error: ${err.message}`);
      }

      if (!verifyResult || typeof verifyResult !== "object" || verifyResult.ok !== true) {
        doReconcile();
        throw new CapabilityExecutionError(
          "verification_failed",
          `Verifikasi hasil capability '${name}' gagal: ${verifyResult?.error || "verifier mengembalikan status bukan ok"}`,
        );
      }

      // 10. Budget reconciliation saat sukses
      doReconcile({ retried: false });

      // Normalized observation
      return {
        ok: true,
        capability: cap.name,
        data: rawResult,
        evidence: verifyResult.evidence || null,
      };
    } finally {
      cleanupResources();
      doReconcile();
    }
  }

  return {
    registerCapability,
    getCapability,
    listCapabilities,
    enableCapability,
    disableCapability,
    clearCapabilities,
    getToolDeclarations,
    executeCapability,
  };
}

// Instance default untuk production (bersih tanpa test capabilities terdaftar otomatis)
const defaultRegistry = createCapabilityRegistry();

function createObservationError(err, capabilityName = "unknown") {
  let status = "failed";
  let code = "execution_failed";
  let message = "Eksekusi capability gagal";

  if (err instanceof CapabilityExecutionError) {
    code = err.code;
    message = err.message;
    if (code === "timeout") {
      status = "timeout";
    } else if (code === "cancelled") {
      status = "cancelled";
    } else {
      status = "failed";
    }
  } else if (err && typeof err === "object") {
    message = String(err.message || message);
    if (err.code === "timeout" || err.name === "TimeoutError") {
      status = "timeout";
      code = "timeout";
    } else if (err.code === "cancelled" || err.name === "AbortError") {
      status = "cancelled";
      code = "cancelled";
    }
  }

  return {
    ok: false,
    status, // failed | timeout | cancelled
    code,
    capability: capabilityName,
    error: message,
    details: err?.details ? { ...err.details } : {},
  };
}

module.exports = {
  createCapabilityRegistry,
  defaultRegistry,
  registerCapability: defaultRegistry.registerCapability,
  getCapability: defaultRegistry.getCapability,
  listCapabilities: defaultRegistry.listCapabilities,
  enableCapability: defaultRegistry.enableCapability,
  disableCapability: defaultRegistry.disableCapability,
  clearCapabilities: defaultRegistry.clearCapabilities,
  getToolDeclarations: defaultRegistry.getToolDeclarations,
  executeCapability: defaultRegistry.executeCapability,
  CapabilityExecutionError,
  formatErrorsForModel,
  createObservationError,
  VALID_RISKS,
  VALID_SIDE_EFFECTS,
  VALID_IDEMPOTENCY,
  buildIdempotencyKey,
  verifyIdempotencyKey,
};
