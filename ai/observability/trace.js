const { redactObject } = require("./redact");

class InMemorySink {
  constructor() {
    this.events = [];
  }

  write(event) {
    this.events.push(event);
  }

  clear() {
    this.events.length = 0;
  }

  getEvents() {
    return [...this.events];
  }
}

class ConsoleSink {
  write(event) {
    // Tampilkan log terstruktur yang ringkas tanpa rahasia
    const costStr = event.cost != null ? `$${event.cost.toFixed(6)}` : "-";
    const latencyStr = event.latencyMs != null ? `${event.latencyMs}ms` : "-";
    const errStr = event.errorCode ? ` [ERROR: ${event.errorCode}]` : "";
    const polStr = event.policyResult ? ` [POLICY: ${event.policyResult.reasonCode}]` : "";
    console.log(
      `[TRACE] ${event.timestamp} ${event.operation}${errStr}${polStr} | model=${event.model || "-"} latency=${latencyStr} cost=${costStr}`,
    );
  }
}

function createTraceLogger(options = {}) {
  const sink = options.sink || new ConsoleSink();
  const maskPhones = Boolean(options.maskPhones);

  function log({
    operation,
    taskId = null,
    correlationId = null,
    model = null,
    provider = null,
    latencyMs = null,
    usage = null,
    cost = null,
    policyResult = null,
    errorCode = null,
    summary = null,
    metadata = null,
  }) {
    // Validasi & pastikan tidak ada prompt lengkap atau CoT
    const safeEvent = {
      timestamp: new Date().toISOString(),
      operation: String(operation || "unknown"),
      taskId: taskId ? String(taskId) : null,
      correlationId: correlationId ? String(correlationId) : null,
      model: model ? String(model) : null,
      provider: provider ? String(provider) : null,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      usage: usage && typeof usage === "object" ? { ...usage } : null,
      cost: Number.isFinite(cost) ? cost : null,
      policyResult: policyResult && typeof policyResult === "object"
        ? { allow: Boolean(policyResult.allow), reasonCode: policyResult.reasonCode || null }
        : null,
      errorCode: errorCode ? String(errorCode) : null,
      summary: summary ? String(summary).slice(0, 300) : null,
      metadata: metadata && typeof metadata === "object" ? redactObject(metadata, { maskPhones }) : null,
    };

    // Pastikan tidak ada raw chain-of-thought atau raw prompts
    delete safeEvent.metadata?.prompt;
    delete safeEvent.metadata?.messages;
    delete safeEvent.metadata?.reasoning;
    delete safeEvent.metadata?.cot;
    delete safeEvent.metadata?.chain_of_thought;
    delete safeEvent.metadata?.response;

    const redacted = redactObject(safeEvent, { maskPhones });
    sink.write(redacted);
    return redacted;
  }

  return {
    log,
    sink,
  };
}

const defaultTraceLogger = createTraceLogger();

module.exports = {
  createTraceLogger,
  defaultTraceLogger,
  InMemorySink,
  ConsoleSink,
};
