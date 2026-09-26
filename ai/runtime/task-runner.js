/**
 * Autonomous Task Runner & Worker untuk Fase 3
 *
 * Persyaratan & Catatan Arsitektur:
 * 1. Runtime task runner/worker yang mengambil task dengan lease+fencing.
 * 2. Memulihkan checkpoint dan memecah goal menjadi langkah bounded.
 * 3. Satu Langkah Tiap Checkpoint (Pilihan ii - sengaja dipertahankan):
 *    Runner mengeksekusi langkah-langkah di dalam loop pada satu pemanggilan runTask
 *    untuk menjaga latensi eksekusi tetap responsif, NAMUN SECARA KETAT MENERAPKAN
 *    CHECKPOINT PERSISTEN SETELAH SETIAP LANGKAH:
 *    - Setiap langkah meng-assert lease dan fencing token.
 *    - Status langkah di-update di SQLite, idempotency record disimpan.
 *    - Task checkpoint disimpan via checkpointTask (status RUNNING, versi naik,
 *      budget snapshot diperbarui, lease diperpanjang).
 *    - Bila terjadi restart/crash, runner berikutnya memulihkan langkah dari checkpoint
 *      terakhir tanpa mengulang langkah yang telah berstatus 'succeeded' (resumable).
 *    - Tidak ada status running menggantung tanpa lease/recovery (dijamin LeaseManager).
 * 4. Task menyimpan actor PN, chat/group, context_epoch, risk level, budgets, dan provenance.
 * 5. Capability loop memakai registry Fase 1: authorize sebelum execute, exact idempotency,
 *    retry budget, cancellation/epoch guard, timeout/abort, dan audit redaction.
 * 6. Verifier deterministik memeriksa output; task berakhir succeeded / failed / blocked / cancelled.
 * 7. Tidak boleh ada status running menggantung tanpa lease/recovery.
 * 8. Semua efek keluar memakai outbox Fase 2; outbox completion dan transisi terminal
 *    dilakukan dalam transaksi atomik idempoten; agent mode wajib allowlist canary (fail closed).
 */

const { LeaseManager, StaleFencingTokenError, LeaseLostError } = require("./lease-manager");
const { TaskStore, TASK_STATUS } = require("./task-state-machine");
const { TaskPlanner, PlannerError } = require("./planner");
const { TaskVerifier } = require("./verifier");
const { DurableBudget, BudgetExhaustedError } = require("./durable-budget");
const { CancellationManager, ApprovalError } = require("./cancellation");
const { OutboxManager } = require("./outbox");
const { AuditManager } = require("./audit");
const { CanaryManager } = require("./canary");
const { defaultRegistry, buildIdempotencyKey } = require("../capabilities/registry");
const { redactObject } = require("../observability/redact");
const engineConfig = require("./engine-config");

class TaskRunner {
  constructor(storage, {
    workerId = null,
    leaseDurationMs = 30_000,
    engineMode = null,
    registry = null,
    planner = null,
    verifier = null,
    canaryManager = null,
    outboxManager = null,
    cancellationManager = null,
    auditManager = null,
    glmClient = null,
  } = {}) {
    if (!storage) {
      throw new Error("storage wajib disertakan untuk TaskRunner");
    }
    this.storage = storage;
    this.workerId = workerId || `task_worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    this.leaseDurationMs = leaseDurationMs;
    this.engineMode = engineMode || engineConfig.getEngineMode();

    this.leaseManager = new LeaseManager(storage, { defaultLeaseDurationMs: leaseDurationMs });
    this.taskStore = new TaskStore(storage);
    this.registry = registry || defaultRegistry;
    this.planner = planner || new TaskPlanner({ glmClient });
    this.verifier = verifier || new TaskVerifier();
    this.canaryManager = canaryManager || new CanaryManager();
    this.cancellationManager = cancellationManager || new CancellationManager(storage);
    this.outboxManager = outboxManager || new OutboxManager(storage, {
      defaultWorkerId: this.workerId,
      engineMode: this.engineMode,
      canaryManager: this.canaryManager,
    });
    this.auditManager = auditManager || new AuditManager(storage);

    this.workerTimer = null;
    this.running = false;
  }

  isShadow() {
    return this.engineMode === engineConfig.ENGINE_MODES.SHADOW;
  }

  isAgent() {
    return this.engineMode === engineConfig.ENGINE_MODES.AGENT;
  }

  /**
   * Menurunkan active scopes secara tepat berdasarkan task.scope,
   * authorization_ref, dan status actor (owner/anggota) tervalidasi.
   * Tidak memberikan 'write' secara buta kepada semua actor.
   */
  deriveActiveScopes(task, actor) {
    const channel = task.chat_id && task.chat_id.endsWith("@g.us") ? "group" : "dm";
    const scopes = new Set([channel, "active_chat", "read"]);

    const isOwner = Boolean(actor?.isOwner);
    if (isOwner) {
      scopes.add("owner");
      scopes.add("write");
    }

    const rawScope = String(task.scope || "").toLowerCase();
    const scopeTokens = rawScope.split(/[\s,;|]+/).filter(Boolean);

    const hasExplicitWriteScope =
      scopeTokens.includes("write") ||
      scopeTokens.includes("read_write") ||
      scopeTokens.includes("rw") ||
      scopeTokens.includes("all");

    const hasExplicitReadOnlyScope =
      scopeTokens.includes("read_only") ||
      scopeTokens.includes("readonly");

    const authRef = String(task.authorization_ref || "").toLowerCase().trim();
    const isAuthRefWriter = /^(?:owner|admin|veto|authorized|write)_/.test(authRef);

    // Capability write hanya bila task memang berhak:
    // (Owner, atau authorization_ref berhak tulis, atau scope eksplisit write) dan bukan read-only
    if ((isOwner || isAuthRefWriter || hasExplicitWriteScope) && !hasExplicitReadOnlyScope) {
      scopes.add("write");
    }

    for (const token of scopeTokens) {
      if (token === "schedule" || token === "send") {
        scopes.add(token);
      }
    }

    return Array.from(scopes);
  }

  /**
   * Menjalankan task secara otonom dari klaim hingga status terminal
   */
  async runTask(taskId) {
    // 1. Klaim task dengan lease + fencing token
    const claim = await this.leaseManager.claimTask(taskId, {
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claim) {
      const existing = await this.storage.getTask(taskId);
      if (existing && existing.status === TASK_STATUS.CANCELLED) {
        return existing;
      }
      return null;
    }
    const fencingToken = claim.fencingToken;

    let task = await this.storage.getTask(taskId);
    if (!task) return null;

    // 2. Cancellation & Context Epoch Guard
    try {
      this.cancellationManager.verifyEpoch(task.chat_id, task.context_epoch);
    } catch (epochErr) {
      await this.cancelTask(taskId, fencingToken, task.version, epochErr.message);
      return this.storage.getTask(taskId);
    }

    if (task.status === TASK_STATUS.CANCELLED || task.status === TASK_STATUS.SUCCEEDED || task.status === TASK_STATUS.FAILED) {
      return task;
    }

    // 3. Inisialisasi Durable Budget
    const budget = new DurableBudget(taskId, this.storage);
    await budget.init();

    try {
      let planResult = null;
      // 4. Periksa apakah langkah sudah ada atau perlu memanggil Planner
      let steps = await this.storage.getTaskSteps(taskId);

      if (steps.length === 0) {
        // Reservasi anggaran untuk pemanggilan Planner GLM
        let planResId = null;
        try {
          planResId = await budget.reserve({ type: "model", estimatedTokens: 600, estimatedCost: 0.001 });
        } catch (budgetErr) {
          await this.failTask(taskId, fencingToken, task.version, "budget_exhausted", budgetErr.message);
          return this.storage.getTask(taskId);
        }

        const channel = task.chat_id.endsWith("@g.us") ? "group" : "dm";
        const availableCaps = this.registry.listCapabilities({ channel, enabledOnly: true });

        try {
          planResult = await this.planner.generatePlan({
            goal: task.goal,
            chatId: task.chat_id,
            actorPn: task.actor_pn,
            channel,
            availableCapabilities: availableCaps,
            contextEpoch: task.context_epoch,
          });
          await budget.reconcile(planResId, {
            actualTokens: planResult.usage?.total_tokens || 350,
            actualCost: 0.0006,
          });
        } catch (plannerErr) {
          await budget.release(planResId);
          await this.failTask(
            taskId,
            fencingToken,
            task.version,
            plannerErr.code || "bad_planner_json",
            plannerErr.message,
          );
          return this.storage.getTask(taskId);
        }

        // Simpan langkah-langkah rencana tervalidasi ke tabel task_steps
        for (const planStep of planResult.plan.steps) {
          const idempKey = buildIdempotencyKey({
            taskId,
            capabilityName: planStep.capability_name,
            logicalOperationId: planStep.logical_operation_id,
          });
          await this.storage.createTaskStep({
            task_id: taskId,
            step_index: planStep.step_index,
            capability_name: planStep.capability_name,
            logical_operation_id: planStep.logical_operation_id,
            idempotency_key: idempKey,
            status: "pending",
            input_redacted: planStep.arguments,
            evidence: planStep.expected_result,
          });
        }

        const initialEvidence = [...(task.evidence_refs || [])];
        if (planResult.plan.final_response) initialEvidence.push({ type: "plan_final_response", text: planResult.plan.final_response });

        // Checkpoint pertama: status running dengan snapshot anggaran
        task = await this.leaseManager.checkpointTask(taskId, {
          workerId: this.workerId,
          fencingToken,
          status: TASK_STATUS.RUNNING,
          updates: {
            budget_snapshot: budget.getSnapshot(),
            evidence_refs: initialEvidence,
          },
        });

        steps = await this.storage.getTaskSteps(taskId);
      }

      // 5. Capability Execution Loop: Satu Langkah Tiap Checkpoint
      for (let cursor = 0; cursor < steps.length; cursor++) {
        const step = steps[cursor];
        if (step.status === "succeeded" || step.status === "superseded") {
          continue; // Lewati langkah yang sudah berhasil
        }

        // a. Assert lease & fencing token terbaru
        await this.leaseManager.assertTaskLease(taskId, {
          workerId: this.workerId,
          fencingToken,
        });

        // b. Guard context epoch sebelum setiap langkah
        this.cancellationManager.verifyEpoch(task.chat_id, task.context_epoch);

        // c. Cek apakah task telah dibatalkan di DB
        const freshTask = await this.storage.getTask(taskId);
        if (freshTask.status === TASK_STATUS.CANCELLED) {
          return freshTask;
        }

        // d. Exact Idempotency Check
        const idempRecord = await this.cancellationManager.checkIdempotency(step.idempotency_key);
        if (idempRecord.alreadyExecuted) {
          await this.storage.updateTaskStep(step.step_id, {
            status: "succeeded",
            observation_redacted: idempRecord.result,
          });
          continue;
        }

        // e. Validasi ketersediaan capability di registry
        const cap = this.registry.getCapability(step.capability_name);
        if (!cap) {
          await this.storage.updateTaskStep(step.step_id, {
            status: "failed",
            error_code: "capability_not_found",
          });
          await this.failTask(
            taskId,
            fencingToken,
            freshTask.version,
            "capability_not_found",
            `Capability '${step.capability_name}' tidak ditemukan di registry`,
          );
          return this.storage.getTask(taskId);
        }

        if (!cap.enabled) {
          await this.storage.updateTaskStep(step.step_id, {
            status: "failed",
            error_code: "capability_disabled",
          });
          await this.failTask(
            taskId,
            fencingToken,
            freshTask.version,
            "capability_disabled",
            `Capability '${step.capability_name}' sedang dinonaktifkan`,
          );
          return this.storage.getTask(taskId);
        }

        // f. Persetujuan Sensitif (Approval Check)
        if (cap.requiresApproval || cap.risk === "high" || cap.risk === "critical") {
          try {
            await this.cancellationManager.verifyAndConsumeApproval({
              taskId,
              actorPn: task.actor_pn,
              capabilityName: step.capability_name,
              logicalOperationId: step.logical_operation_id,
              args: step.input_redacted,
            });
          } catch (approvalErr) {
            // Butuh persetujuan! Alihkan status ke waiting_approval dan simpan checkpoint
            await this.taskStore.transitionTask(taskId, TASK_STATUS.WAITING_APPROVAL, {
              expectedVersion: freshTask.version,
            });
            await this.leaseManager.checkpointTask(taskId, {
              workerId: this.workerId,
              fencingToken,
              status: TASK_STATUS.WAITING_APPROVAL,
            });
            await this.auditManager.recordEvent({
              eventType: "task_waiting_approval",
              taskId,
              actorPn: task.actor_pn,
              details: {
                step_id: step.step_id,
                capability_name: step.capability_name,
                reason: approvalErr.message,
              },
            });
            return this.storage.getTask(taskId);
          }
        }

        // g. Canary Allowlist Guard untuk efek keluar pada Mode Agent
        if (this.isAgent() && (cap.sideEffect === "send" || cap.sideEffect === "external")) {
          const isAllowed = this.canaryManager.isAllowed({
            chatId: task.chat_id,
            actorPn: task.actor_pn,
            engineMode: this.engineMode,
          });
          if (!isAllowed) {
            await this.storage.updateTaskStep(step.step_id, {
              status: "failed",
              error_code: "canary_denied",
            });
            await this.failTask(
              taskId,
              fencingToken,
              freshTask.version,
              "canary_denied",
              `Efek eksternal ditolak oleh canary allowlist (fail closed) untuk chat ${task.chat_id}`,
            );
            return this.storage.getTask(taskId);
          }
        }

        // h. Tandai langkah sebagai running
        await this.storage.updateTaskStep(step.step_id, { status: "running" });

        // i. Konteks eksekusi terverifikasi Fase 1
        const isOwner = this.canaryManager.isOwner(task.actor_pn);
        const actor = {
          id: task.actor_pn,
          pn: task.actor_pn,
          verified: task.verified === false ? false : true,
          provenance: task.provenance || "runtime_inbound_message",
          isOwner,
        };

        const activeScopes = this.deriveActiveScopes(task, actor);

        const execContext = {
          actor,
          activeScopes,
          channel: task.chat_id.endsWith("@g.us") ? "group" : "dm",
          originChatId: task.chat_id,
          taskId,
          logicalOperationId: step.logical_operation_id,
          idempotencyKey: step.idempotency_key,
          budget,
          storage: this.storage,
          engineMode: this.engineMode,
        };

        // j. Eksekusi capability dengan timeout/cancellation race Fase 1
        let observation;
        try {
          const resolvedInput = await this.resolveStepArguments(taskId, step);
          observation = await this.registry.executeCapability(
            step.capability_name,
            resolvedInput,
            execContext,
          );
        } catch (err) {
          const isRetryExhausted =
            err.reason === "retries_exhausted" ||
            (err.cause && err.cause.reason === "retries_exhausted") ||
            (err.message && err.message.includes("retries_exhausted"));
          observation = {
            ok: false,
            error_code: isRetryExhausted ? "retry_budget_exhausted" : (err.code || "execution_error"),
            message: err.message,
            retryable: !isRetryExhausted && (err.code === "timeout" || err.code === "rate_limit"),
          };
        }

        // k. Verifikasi hasil deterministik melalui Verifier
        const verif = await this.verifier.verifyStepResult({
          step,
          capability: cap,
          observation,
          context: execContext,
        });

        if (!verif.ok) {
          // Langkah gagal verifikasi
          await this.storage.updateTaskStep(step.step_id, {
            status: "failed",
            error_code: verif.code,
            observation_redacted: observation,
          });

          // Periksa apakah error sementara dan budget retry masih tersedia
          if (observation.retryable) {
            try {
              await budget.recordRetry();
              await this.storage.updateTaskStep(step.step_id, { status: "retry_wait" });
              await this.leaseManager.checkpointTask(taskId, {
                workerId: this.workerId,
                fencingToken,
                status: TASK_STATUS.RETRY_WAIT,
              });
              return this.storage.getTask(taskId);
            } catch (budgetErr) {
              await this.failTask(
                taskId,
                fencingToken,
                freshTask.version,
                "retry_budget_exhausted",
                "Retry budget habis untuk langkah ini",
              );
              return this.storage.getTask(taskId);
            }
          }

          // Replan terbatas hanya untuk kegagalan baca/perhitungan sebelum efek tulis/kirim.
          const replanned = await this.tryReplan({ task, step, steps, cap, verif, budget, fencingToken });
          if (replanned) {
            task = replanned;
            const previousCount = steps.length;
            steps = await this.storage.getTaskSteps(taskId);
            cursor = previousCount - 1;
            continue;
          }

          // Non-retryable failure
          await this.failTask(taskId, fencingToken, freshTask.version, verif.code, verif.error);
          return this.storage.getTask(taskId);
        }

        // l. Langkah berhasil terverifikasi: simpan idempotency & checkpoint
        await this.storage.updateTaskStep(step.step_id, {
          status: "succeeded",
          observation_redacted: observation,
          evidence: JSON.stringify(verif.evidence),
        });

        await this.cancellationManager.recordIdempotency(step.idempotency_key, {
          taskId,
          capabilityName: step.capability_name,
          logicalOperationId: step.logical_operation_id,
          result: observation,
        });

        const currentEvidences = task.evidence_refs || [];
        const nextEvidences = [...currentEvidences, verif.evidence];

        task = await this.leaseManager.checkpointTask(taskId, {
          workerId: this.workerId,
          fencingToken,
          status: TASK_STATUS.RUNNING,
          updates: {
            budget_snapshot: budget.getSnapshot(),
            evidence_refs: nextEvidences,
          },
        });

        await this.auditManager.recordEvent({
          eventType: "task_step_succeeded",
          taskId,
          actorPn: task.actor_pn,
          details: {
            step_index: step.step_index,
            logical_operation_id: step.logical_operation_id,
            capability_name: step.capability_name,
          },
        });
      }

      // 6. Verifikasi Penyelesaian Task Menyeluruh
      const allSteps = await this.storage.getTaskSteps(taskId);
      const latestTask = await this.storage.getTask(taskId);

      // Jika task sudah terminal, return langsung (idempotent)
      if (latestTask.status === TASK_STATUS.SUCCEEDED) {
        return latestTask;
      }

      if (latestTask.status !== TASK_STATUS.VERIFYING) {
        await this.taskStore.transitionTask(taskId, TASK_STATUS.VERIFYING, {
          expectedVersion: latestTask.version,
        });
      }

      const finalVerif = this.verifier.verifyTaskCompletion({
        task: latestTask,
        steps: allSteps,
        evidenceRefs: latestTask.evidence_refs,
      });

      if (!finalVerif.ok) {
        await this.failTask(
          taskId,
          fencingToken,
          latestTask.version + 1,
          finalVerif.code,
          finalVerif.error,
        );
        return this.storage.getTask(taskId);
      }

      // 7 & 8. Transaksi Atomik: Outbox Intent & Transisi Terminal Task (Point A & E)
      let completionText = "Tugas berhasil diselesaikan dengan bukti lengkap.";
      const latestPlanEvidence = Array.isArray(latestTask.evidence_refs)
        ? [...latestTask.evidence_refs].reverse().find((e) => e && (e.type === "plan_final_response" || e.plan_final_response || e.final_response))
        : null;
      const planFinalResponse = latestPlanEvidence?.final_response || latestPlanEvidence?.text || latestPlanEvidence?.plan_final_response || planResult?.plan?.final_response;
      if (planFinalResponse && typeof planFinalResponse === "string" && planFinalResponse.trim()) {
        completionText = planFinalResponse.trim();
      }

      const outboxIdempKey = buildIdempotencyKey({
        taskId,
        capabilityName: allSteps.some((step) => step.capability_name === "send_asset" && step.status === "succeeded") ? "send_asset" : "send_message",
        logicalOperationId: allSteps.some((step) => step.capability_name === "send_asset" && step.status === "succeeded") ? "final_asset_delivery_outbox" : "final_task_completion_outbox",
      });

      const assetSendStep = allSteps.find((step) => step.capability_name === "send_asset" && step.status === "succeeded");
      const assetSend = assetSendStep?.observation_redacted?.data || null;
      if (assetSendStep && (!assetSend?.asset_id || !["image", "sticker"].includes(assetSend.mode))) {
        await this.failTask(taskId, fencingToken, latestTask.version + 1, "asset_delivery_invalid", "Asset pengiriman tidak valid");
        return this.storage.getTask(taskId);
      }

      const { task: completedTask, outbox: completionOutbox } = await this.storage.completeTaskWithOutboxIntent({
        taskId,
        workerId: this.workerId,
        fencingToken,
        terminalStatus: assetSend ? TASK_STATUS.VERIFYING : TASK_STATUS.SUCCEEDED,
        evidenceRefs: finalVerif.evidenceRefs,
        outboxIntent: {
          destination: latestTask.chat_id,
          content_type: assetSend ? assetSend.mode : "text",
          payload: assetSend
            ? { asset_id: assetSend.asset_id, task_id: taskId, chat_id: latestTask.chat_id, mime: assetSend.mime }
            : { text: completionText },
          context_epoch: latestTask.context_epoch,
          idempotency_key: outboxIdempKey,
        },
      });

      await this.auditManager.recordEvent({
        eventType: completedTask.status === TASK_STATUS.SUCCEEDED ? "task_succeeded" : `task_${completedTask.status}`,
        taskId,
        actorPn: latestTask.actor_pn,
        details: {
          total_steps: allSteps.length,
          evidence_count: (finalVerif.evidenceRefs || []).length,
          outbox_id: completionOutbox?.outbox_id || null,
          outbox_status: completionOutbox?.status || null,
        },
      });

      return completedTask;
    } catch (err) {
      if (err instanceof StaleFencingTokenError || err instanceof LeaseLostError) {
        // Lease diambil alih oleh worker lain; hentikan eksekusi segera tanpa menulis ke DB
        console.warn(`[TASK-RUNNER] ${err.name} pada task ${taskId}: worker melepaskan tugas.`);
        return null;
      }

      // Tangani error fatal tak terduga agar task tidak menggantung di running
      console.error(`[TASK-RUNNER] Error fatal pada eksekusi task ${taskId}:`, err.message);
      const safeMessage = err.message ? String(err.message).slice(0, 500) : "Internal runner error";
      await this.failTask(taskId, fencingToken, null, "internal_runner_error", safeMessage);
      return this.storage.getTask(taskId);
    }
  }

  async tryReplan({ task, step, steps, cap, verif, budget, fencingToken }) {
    if (!["read", "none"].includes(cap.sideEffect) || Number(task.plan_version || 1) >= 3) return null;
    if (!(cap.name === "read_note" && verif.code === "execution_failed" && /tidak ditemukan/i.test(String(verif.error || "")))) return null;
    if (steps.some((item) => item.status === "succeeded" && !["read", "none"].includes(this.registry.getCapability(item.capability_name)?.sideEffect))) return null;
    const remaining = 8 - steps.length;
    if (remaining < 1) return null;
    const reservation = await budget.reserve({ type: "model", estimatedTokens: 600, estimatedCost: 0.001 }).catch(() => null);
    if (!reservation) return null;
    let generated;
    try {
      generated = await this.planner.generatePlan({
        goal: task.goal,
        chatId: task.chat_id,
        actorPn: task.actor_pn,
        channel: task.chat_id.endsWith("@g.us") ? "group" : "dm",
        availableCapabilities: this.registry.listCapabilities({ channel: task.chat_id.endsWith("@g.us") ? "group" : "dm", enabledOnly: true }),
        contextEpoch: task.context_epoch,
        historySummary: `Rencana awal gagal pada ${step.capability_name} (${verif.code}). Langkah baca/perhitungan yang sudah sukses: ${steps.filter((s) => s.status === "succeeded").map((s) => s.capability_name).join(", ")}. Buat hanya langkah LANJUTAN, jangan ulangi langkah yang sukses. Maksimum ${remaining} langkah.`,
      });
      await budget.reconcile(reservation, { actualTokens: generated.usage?.total_tokens || 350, actualCost: 0.0006 });
    } catch {
      await budget.release(reservation);
      return null;
    }
    if (generated.plan.steps.length > remaining) return null;
    const version = Number(task.plan_version || 1) + 1;
    const newSteps = generated.plan.steps.map((item) => {
      const logicalOperationId = `r${version}_${item.logical_operation_id}`.slice(0, 64);
      return {
        step_id: `step_${require("node:crypto").randomUUID()}`,
        capability_name: item.capability_name,
        logical_operation_id: logicalOperationId,
        idempotency_key: buildIdempotencyKey({ taskId: task.task_id, capabilityName: item.capability_name, logicalOperationId }),
        input_redacted: item.arguments,
        evidence: item.expected_result,
      };
    });
    try {
      const updated = await this.storage.replaceRemainingStepsForReplan({
        taskId: task.task_id,
        workerId: this.workerId,
        fencingToken,
        failedStepIndex: step.step_index,
        newSteps,
        evidence: { type: "replan", from_step: step.step_index, reason: verif.code, plan_version: version, final_response: generated.plan.final_response || null },
      });
      await this.auditManager.recordEvent({ eventType: "task_replanned", taskId: task.task_id, actorPn: task.actor_pn, details: { from_step: step.step_index, plan_version: version, new_steps: newSteps.length, reason: verif.code } });
      return updated;
    } catch (error) {
      if (error instanceof StaleFencingTokenError) throw error;
      return null;
    }
  }

  async resolveStepArguments(taskId, step) {
    const input = step.input_redacted || {};
    if (input.asset_id !== "$last_asset") return input;
    const previous = (await this.storage.getTaskSteps(taskId))
      .filter((candidate) => candidate.step_index < step.step_index && candidate.status === "succeeded")
      .reverse()
      .find((candidate) => candidate.observation_redacted?.data?.asset_id);
    const assetId = previous?.observation_redacted?.data?.asset_id;
    if (!assetId) throw Object.assign(new Error("asset_reference_missing"), { code: "asset_reference_missing" });
    return { ...input, asset_id: assetId };
  }

  async failTask(taskId, fencingToken, expectedVersion, errorCode, errorMessage) {
    try {
      const current = await this.storage.getTask(taskId);
      if (current && current.status !== TASK_STATUS.FAILED && current.status !== TASK_STATUS.CANCELLED) {
        const safeError = typeof errorMessage === "string" ? errorMessage.slice(0, 500) : String(errorMessage || "").slice(0, 500);
        const errorEvidence = { error: safeError, code: errorCode, at: new Date().toISOString() };
        const evidenceRefs = [...(current.evidence_refs || []), errorEvidence];

        await this.storage.updateTask(taskId, {
          expectedVersion: expectedVersion != null ? expectedVersion : current.version,
          status: TASK_STATUS.FAILED,
          evidence_refs: evidenceRefs,
        });

        await this.storage.releaseLease({
          resourceType: "task",
          resourceId: taskId,
          workerId: this.workerId,
          fencingToken,
        });

        await this.auditManager.recordEvent({
          eventType: "task_failed",
          taskId,
          actorPn: current.actor_pn,
          details: { code: errorCode, error: safeError },
        });
      }
    } catch (err) {
      console.warn(`[TASK-RUNNER] Gagal menandai task ${taskId} sebagai failed:`, err.message);
    }
  }

  async cancelTask(taskId, fencingToken, expectedVersion, reason) {
    try {
      const current = await this.storage.getTask(taskId);
      if (current && current.status !== TASK_STATUS.CANCELLED && current.status !== TASK_STATUS.SUCCEEDED) {
        await this.storage.updateTask(taskId, {
          expectedVersion: expectedVersion != null ? expectedVersion : current.version,
          status: TASK_STATUS.CANCELLED,
          evidence_refs: [...(current.evidence_refs || []), { cancelled_reason: reason }],
        });
        await this.storage.releaseLease({
          resourceType: "task",
          resourceId: taskId,
          workerId: this.workerId,
          fencingToken,
        });
        await this.auditManager.recordEvent({
          eventType: "task_cancelled",
          taskId,
          actorPn: current.actor_pn,
          details: { reason },
        });
      }
    } catch (err) {
      console.warn(`[TASK-RUNNER] Gagal membatalkan task ${taskId}:`, err.message);
    }
  }

  /**
   * Menjalankan tick worker untuk memproses task yang sedang mengantre
   */
  async tick() {
    const queuedTasks = await this.storage.listTasks({ status: TASK_STATUS.QUEUED, limit: 5 });
    for (const t of queuedTasks) {
      await this.runTask(t.task_id);
    }
  }

  start({ intervalMs = 2_000 } = {}) {
    if (this.workerTimer) return;
    this.running = true;
    this.workerTimer = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.warn("[TASK-RUNNER] Worker tick error:", err.message);
      }
    }, intervalMs);

    if (typeof this.workerTimer.unref === "function") {
      this.workerTimer.unref();
    }
  }

  stop() {
    this.running = false;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }
}

module.exports = {
  TaskRunner,
};
