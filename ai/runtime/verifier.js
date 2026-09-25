/**
 * Deterministic Task Verifier untuk Runtime Otonom (Fase 3)
 *
 * Persyaratan:
 * 1. Verifier deterministik memeriksa output sesuai schema, expected result, dan policy.
 * 2. Task harus berakhir succeeded / failed / blocked / cancelled dengan reason audit.
 * 3. Tidak boleh status running menggantung tanpa lease/recovery.
 * 4. Verifikasi bukti nyata (evidence-based completion), bukan penilaian sepihak model.
 */

class VerifierError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VerifierError";
    this.code = details.code || "verifier_error";
    this.details = details;
  }
}

class TaskVerifier {
  /**
   * Verifikasi hasil langkah tunggal (step observation)
   */
  async verifyStepResult({ step, capability, observation, context = {} }) {
    if (!step) {
      return { ok: false, code: "missing_step_definition", error: "Definisi step hilang" };
    }

    if (!observation || typeof observation !== "object") {
      return { ok: false, code: "missing_observation", error: "Observasi eksekusi hilang" };
    }

    // 1. Cek observasi dasar
    if (!observation.ok) {
      return {
        ok: false,
        code: observation.error_code || "step_execution_failed",
        error: observation.message || "Eksekusi capability melaporkan kegagalan",
        retryable: Boolean(observation.retryable),
      };
    }

    // 2. Verifikasi output schema jika capability terdaftar
    if (capability && typeof capability.validateOutput === "function") {
      const isOutputValid = capability.validateOutput(observation.data);
      if (!isOutputValid) {
        return {
          ok: false,
          code: "output_schema_mismatch",
          error: "Output capability tidak sesuai dengan kontrak outputSchema",
          details: capability.validateOutput.errors,
        };
      }
    }

    // 3. Verifikasi kustom capability verifier
    if (capability && typeof capability.verifier === "function") {
      try {
        const verifRes = await capability.verifier(observation.data, context);
        if (!verifRes || !verifRes.ok) {
          return {
            ok: false,
            code: "capability_verifier_rejected",
            error: verifRes?.error || "Fungsi verifier capability menolak data hasil",
          };
        }
      } catch (err) {
        return {
          ok: false,
          code: "capability_verifier_exception",
          error: `Verifier capability melempar error: ${err.message}`,
        };
      }
    }

    // 4. Verifikasi isolasi obrolan asal (origin chat isolation)
    if (capability && (capability.sideEffect === "write" || capability.sideEffect === "send")) {
      const originChatId = context.originChatId;
      if (originChatId && observation.data?.chat_id && observation.data.chat_id !== originChatId) {
        return {
          ok: false,
          code: "origin_chat_violation",
          error: `Pelanggaran batas chat: data ditulis untuk ${observation.data.chat_id} tetapi chat aktif adalah ${originChatId}`,
        };
      }
    }

    // 5. Rakit bukti (evidence) terverifikasi
    const evidence = {
      step_index: step.step_index,
      logical_operation_id: step.logical_operation_id,
      capability_name: step.capability_name,
      evidence: observation.evidence || observation.data || null,
      side_effect_status: step.capability_name === "send_asset" ? "pending_delivery" : (observation.sideEffectStatus || "completed"),
      verified_at: new Date().toISOString(),
    };

    return {
      ok: true,
      evidence,
    };
  }

  /**
   * Verifikasi penyelesaian task secara menyeluruh sebelum dinyatakan succeeded
   */
  verifyTaskCompletion({ task, steps = [], evidenceRefs = [] }) {
    if (!task) {
      return { ok: false, code: "task_not_found", error: "Task tidak ditemukan" };
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, code: "empty_steps", error: "Task tidak memiliki jejak langkah eksekusi" };
    }

    // 1. Semua langkah yang direncanakan harus berstatus 'succeeded'
    if (!steps.some((step) => step.status === "succeeded")) {
      return { ok: false, code: "no_verified_steps", error: "Tidak ada langkah yang berhasil diverifikasi" };
    }
    for (const step of steps) {
      if (step.status === "superseded") continue;
      if (step.status !== "succeeded") {
        return {
          ok: false,
          code: "incomplete_steps",
          error: `Langkah '${step.logical_operation_id}' (indeks ${step.step_index}) berstatus '${step.status}', belum selesai`,
          step: step.logical_operation_id,
        };
      }
    }

    // 2. Kriteria penerimaan (acceptance criteria)
    if (task.acceptance_criteria) {
      if (!evidenceRefs || evidenceRefs.length === 0) {
        return {
          ok: false,
          code: "acceptance_criteria_unmet",
          error: "Bukti teknis (evidence) kosong, acceptance criteria tidak dapat dibuktikan",
        };
      }
    }

    return {
      ok: true,
      evidenceRefs: evidenceRefs || [],
      completedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  TaskVerifier,
  VerifierError,
};
