/**
 * Transactional Outbox & Delivery Uncertainty untuk Runtime Durable (Fase 2)
 *
 * Prinsip:
 * 1. Intent outbox ditulis dalam transaksi yang sama dengan task/job/step.
 * 2. Eksekusi delivery selalu dilakukan DI LUAR transaksi DB via injectable transport.
 * 3. Menyimpan deterministic idempotency key dari helper Fase 1.
 * 4. Status: pending, claimed, sending, delivered, uncertain, retry_wait, failed, cancelled.
 * 5. Crash sesudah send sebelum commit menghasilkan status 'delivery_uncertain' (TIDAK BOLEH blind resend).
 * 6. Tidak mengklaim exactly-once WhatsApp. Dokumentasi jujur batas at-least-once / uncertainty.
 * 7. Reconciliation API menerima bukti transport/message ID; tanpa bukti tetap uncertain atau butuh aksi manusia.
 */

const { buildIdempotencyKey, verifyIdempotencyKey } = require("../capabilities/registry");
const memoryStore = require("../memory-store");
const humanize = require("../humanize");
const engineConfig = require("./engine-config");
const { CanaryManager } = require("./canary");

const OUTBOX_STATUS = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  SENDING: "sending",
  DELIVERED: "delivered",
  UNCERTAIN: "uncertain",
  RETRY_WAIT: "retry_wait",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

class DeliveryUncertainError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DeliveryUncertainError";
    this.code = "delivery_uncertain";
    this.details = details;
  }
}

class OutboxManager {
  constructor(storage, {
    defaultWorkerId = "outbox-worker-1",
    leaseDurationMs = 30000,
    engineMode = null,
    memoryStore: customMemoryStore = null,
    canaryManager = null,
  } = {}) {
    this.storage = storage;
    this.defaultWorkerId = defaultWorkerId;
    this.leaseDurationMs = leaseDurationMs;
    this.engineMode = engineMode || engineConfig.getEngineMode();
    this.memoryStore = customMemoryStore || memoryStore;
    this.canaryManager = canaryManager || new CanaryManager();
  }

  isAgent() {
    return this.engineMode === "agent" || engineConfig.isAgent();
  }

  isShadow() {
    return this.engineMode === "shadow" || engineConfig.isShadow();
  }

  /**
   * Membuat intent pengiriman pesan dalam transaksi atomik
   */
  async createIntent({
    taskId = null,
    jobId = null,
    destination,
    contentType = "text",
    payload,
    contextEpoch = 0,
    logicalOperationId,
    capabilityName = "send_message",
    idempotencyKey = null,
    idempotent = false,
  }, tx = null, options = {}) {
    if (!destination || typeof destination !== "string") {
      throw new Error("destination wajib non-empty string");
    }

    const effectiveTaskId = String(taskId || jobId || "").trim();
    if (!effectiveTaskId) {
      throw new Error("taskId atau jobId wajib non-empty untuk membuat intent outbox");
    }

    if (!logicalOperationId || typeof logicalOperationId !== "string" || !logicalOperationId.trim()) {
      throw new Error("logicalOperationId wajib eksplisit dan non-empty string");
    }

    const isIdempotent = Boolean(idempotent || (options && options.idempotent));

    // Bentuk idempotency key deterministik bila belum diberikan
    let effectiveKey = idempotencyKey;
    if (!effectiveKey) {
      effectiveKey = buildIdempotencyKey({
        taskId: effectiveTaskId,
        capabilityName,
        logicalOperationId: logicalOperationId.trim(),
      });
    }

    if (isIdempotent) {
      const existing = await this.storage.getOutboxByIdempotencyKey(effectiveKey, tx);
      if (existing) {
        return existing;
      }
    }

    return this.storage.createOutboxIntent({
      task_id: taskId || null,
      job_id: jobId || null,
      destination,
      content_type: contentType,
      payload,
      idempotency_key: effectiveKey,
      context_epoch: contextEpoch,
      status: OUTBOX_STATUS.PENDING,
      idempotent: isIdempotent,
    }, tx, { idempotent: isIdempotent });
  }

  async ensureOutboxIntent(params, tx = null, options = {}) {
    return this.createIntent(params, tx, { ...options, idempotent: true });
  }

  /**
   * Mengirim satu pesan outbox melalui transport yang diinjeksi
   */
  async processOutboxItem(item, transport, { workerId = this.defaultWorkerId, cancellationManager = null } = {}) {
    // 1. Claim outbox item
    const claimed = await this.storage.claimOutbox(item.outbox_id, {
      workerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claimed) {
      const current = await this.storage.getOutbox(item.outbox_id);
      if (current && current.status === "cancelled") {
        return current;
      }
      return null;
    }

    // 2. Guard context epoch sebelum delivery
    if (cancellationManager && typeof cancellationManager.getEpoch === "function") {
      const currentEpoch = cancellationManager.getEpoch(claimed.destination);
      if (Number(claimed.context_epoch || 0) < currentEpoch) {
        await this.storage.cancelOutbox(claimed.outbox_id, {
          workerId,
          fencingToken: claimed.fencing_token,
          errorMessage: `Context epoch kadaluwarsa (${claimed.context_epoch} < ${currentEpoch})`,
        });
        if (claimed.job_id) {
          await this.storage.updateJob(claimed.job_id, {
            status: "cancelled",
            error_message: `Context epoch kadaluwarsa sebelum delivery (${claimed.context_epoch} < ${currentEpoch})`,
          });
        }
        return this.storage.getOutbox(claimed.outbox_id);
      }
    }

    // 3. Guard policy / whitelist / optout / proactive sebelum delivery
    const isGroupChat = String(claimed.destination || "").endsWith("@g.us");
    const phone = !isGroupChat ? this.memoryStore.normalizePhone(claimed.destination || claimed.payload?.phone) : null;
    if (phone) {
      if (!this.memoryStore.canDirectMessage(phone)) {
        await this.storage.cancelOutbox(claimed.outbox_id, {
          workerId,
          fencingToken: claimed.fencing_token,
          errorMessage: `Penerima ${phone} tidak berada dalam whitelist DM`,
        });
        if (claimed.job_id) {
          await this.storage.updateJob(claimed.job_id, {
            status: "blocked",
            error_message: `Penerima ${phone} tidak berada dalam whitelist DM`,
          });
        }
        return this.storage.getOutbox(claimed.outbox_id);
      }

      if (this.memoryStore.getDmMemory(phone).opt_out) {
        await this.storage.cancelOutbox(claimed.outbox_id, {
          workerId,
          fencingToken: claimed.fencing_token,
          errorMessage: `Penerima ${phone} telah opt-out`,
        });
        if (claimed.job_id) {
          await this.storage.updateJob(claimed.job_id, {
            status: "blocked",
            error_message: `Penerima ${phone} telah opt-out`,
          });
        }
        return this.storage.getOutbox(claimed.outbox_id);
      }

      if (claimed.payload?.proactive) {
        const at = Date.now();
        if (humanize.isQuietHours(at)) {
          await this.storage.cancelOutbox(claimed.outbox_id, {
            workerId,
            fencingToken: claimed.fencing_token,
            errorMessage: "Pesan proaktif dibatalkan: jam tenang",
          });
          if (claimed.job_id) {
            await this.storage.updateJob(claimed.job_id, {
              status: "expired",
              error_message: "Pesan proaktif dibatalkan: jam tenang",
            });
          }
          return this.storage.getOutbox(claimed.outbox_id);
        }
        const dm = this.memoryStore.getDmMemory(phone);
        const cfg = {
          dailyLimit: Math.max(0, Number(process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT) || 5),
          personCooldownMs: Math.max(0, Number(process.env.AI_AGENT_PERSON_COOLDOWN_HOURS) || 20) * 3_600_000,
        };
        if (dm.last_proactive_at && at - dm.last_proactive_at < cfg.personCooldownMs) {
          await this.storage.cancelOutbox(claimed.outbox_id, {
            workerId,
            fencingToken: claimed.fencing_token,
            errorMessage: "Pesan proaktif dibatalkan: person cooldown",
          });
          if (claimed.job_id) {
            await this.storage.updateJob(claimed.job_id, {
              status: "blocked",
              error_message: "Pesan proaktif dibatalkan: person cooldown",
            });
          }
          return this.storage.getOutbox(claimed.outbox_id);
        }
      }
    }

    // 3b. Guard Canary Allowlist untuk Autonomous Tasks pada Mode Agent
    if (claimed.task_id && this.isAgent()) {
      const allowed = this.canaryManager.isAllowed({
        chatId: claimed.destination,
        actorPn: phone,
        engineMode: this.engineMode,
      });
      if (!allowed) {
        await this.storage.cancelOutbox(claimed.outbox_id, {
          workerId,
          fencingToken: claimed.fencing_token,
          errorMessage: `Penerima ${claimed.destination} tidak diizinkan oleh canary allowlist (fail closed)`,
        });
        return this.storage.getOutbox(claimed.outbox_id);
      }
    }

    // 3c. Shadow Mode Guard: zero external sends, simulated outbox only!
    if (this.isShadow()) {
      const simulatedReceipt = {
        simulated: true,
        shadow: true,
        timestamp: new Date().toISOString(),
      };
      await this.storage.markOutboxDelivered(claimed.outbox_id, {
        workerId,
        fencingToken: claimed.fencing_token,
        transportMessageId: `sim_shadow_${Date.now()}`,
        deliveryReceipt: simulatedReceipt,
      });
      if (claimed.job_id) {
        await this.storage.updateJob(claimed.job_id, {
          status: "sent",
          delivery_receipt: simulatedReceipt,
        });
      }
      return this.storage.getOutbox(claimed.outbox_id);
    }

    // 4. Tandai status 'sending' sebelum memanggil transport
    await this.storage.markOutboxSending(claimed.outbox_id, {
      workerId,
      fencingToken: claimed.fencing_token,
    });

    try {
      // 5. Eksekusi pengiriman di LUAR transaksi database melalui transport yang diinjeksi
      const result = await transport.send({
        destination: claimed.destination,
        contentType: claimed.content_type,
        payload: claimed.payload,
        idempotencyKey: claimed.idempotency_key,
      });

      // 6. Jika transport mengindikasikan crash post-send (simulasi pengujian)
      if (transport.simulateCrashPostSend) {
        throw new Error("SIMULATED_POST_SEND_CRASH");
      }

      // 7. Pengiriman sukses -> persist delivery receipt
      const messageId = result?.messageId || result?.key?.id || null;
      await this.storage.markOutboxDelivered(claimed.outbox_id, {
        workerId,
        fencingToken: claimed.fencing_token,
        transportMessageId: messageId,
        deliveryReceipt: result,
      });

      // Update status job jika dihubungkan dengan job_id
      if (claimed.job_id) {
        await this.storage.updateJob(claimed.job_id, {
          status: "sent",
          delivery_receipt: result,
        });
        if (phone && !this.isShadow() && engineConfig.canWriteProductionMemory()) {
          this.memoryStore.noteBotDm(phone, { at: Date.now(), proactive: Boolean(claimed.payload?.proactive) });
        }
      }

      return this.storage.getOutbox(claimed.outbox_id);
    } catch (error) {
      if (error.message === "SIMULATED_POST_SEND_CRASH" || error.code === "ERR_POST_SEND_UNCOMMITTED") {
        // Terjadi setelah transport mengirim pesan tetapi sebelum DB meng-commit 'delivered'
        // Status HARUS menjadi 'delivery_uncertain' dan TIDAK BOLEH di-resend secara buta!
        await this.storage.markOutboxUncertain(claimed.outbox_id, {
          workerId,
          fencingToken: claimed.fencing_token,
          errorMessage: "Pengiriman berhasil di transport tetapi proses terputus sebelum commit status",
        });
        if (claimed.job_id) {
          await this.storage.updateJob(claimed.job_id, {
            status: "delivery_uncertain",
            error_message: "Pengiriman berhasil di transport tetapi proses terputus sebelum commit status",
          });
        }
        return this.storage.getOutbox(claimed.outbox_id);
      }

      // Error pengiriman biasa
      console.warn(`[OUTBOX] Gagal mengirim pesan outbox ${claimed.outbox_id}:`, error.message);
      await this.storage.failOrRetryOutbox(claimed.outbox_id, {
        workerId,
        fencingToken: claimed.fencing_token,
        errorMessage: error.message,
      });
      if (claimed.job_id) {
        const outboxNow = await this.storage.getOutbox(claimed.outbox_id);
        await this.storage.updateJob(claimed.job_id, {
          status: outboxNow?.status === "failed" ? "failed" : "retry_wait",
          error_message: error.message,
        });
      }
      return this.storage.getOutbox(claimed.outbox_id);
    }
  }

  /**
   * Menguras antrean outbox yang tertunda
   */
  async drainOutbox(transport, { limit = 10, workerId = this.defaultWorkerId, cancellationManager = null } = {}) {
    const pendingItems = await this.storage.listPendingOutbox({ limit });
    const results = [];
    for (const item of pendingItems) {
      const processed = await this.processOutboxItem(item, transport, { workerId, cancellationManager });
      if (processed) {
        if (["image", "sticker"].includes(processed.content_type)) await this.storage.settleAssetTaskFromOutbox(processed.outbox_id);
        results.push(processed);
      }
    }
    return results;
  }

  /**
   * Rekonsiliasi pesan berstatus 'uncertain': membutuhkan bukti pesan dari transport
   */
  async reconcileDelivery({ outboxId, transportMessageId = null, deliveryReceipt = null, confirmed = false }) {
    const item = await this.storage.getOutbox(outboxId);
    if (!item) throw new Error(`Outbox ${outboxId} tidak ditemukan`);

    if (confirmed && transportMessageId) {
      await this.storage.reconcileOutbox(outboxId, {
        status: OUTBOX_STATUS.DELIVERED,
        transportMessageId,
        deliveryReceipt: deliveryReceipt || { reconciled: true, confirmedAt: new Date().toISOString() },
      });
      await this.storage.settleAssetTaskFromOutbox(outboxId);
      return this.storage.getOutbox(outboxId);
    }

    if (!confirmed || !transportMessageId) {
      // ID tanpa konfirmasi independen belum membuktikan pengiriman.
      return item;
    }
  }
}

module.exports = {
  OUTBOX_STATUS,
  OutboxManager,
  DeliveryUncertainError,
};
