/**
 * Durable Scheduler untuk Runtime Durable (Fase 2)
 *
 * Menggantikan scheduler JSON pop-before-run dengan persistensi tabel jobs di SQLite:
 * - Tidak pernah menghapus job sebelum eksekusi selesai.
 * - Siklus hidup lengkap: scheduled, claimed, running, sent, retry_wait, blocked, expired, cancelled, delivery_uncertain, failed.
 * - Emergency pause terpisah dari off (pause menghentikan seluruh klaim/efek termasuk reminder).
 * - Reminder eksplisit tetap diproses saat proaktif off, kecuali saat emergency pause.
 * - Reminder terlambat <= 24 jam dikirim sekali dengan metadata late; > 24 jam menjadi expired.
 * - Check-in basi (> 1 jam atau jam tenang) otomatis dilewati/expired, bukan ditumpuk.
 * - Retry transient memakai eksponensial backoff + jitter dan max attempts.
 * - TIDAK PERNAH memanggil sock.sendMessage langsung: semua pengiriman wajib melalui OutboxManager!
 * - Transaksi atomik: outbox intent, status job running, dan idempotency record ditulis dalam satu transaksi DB.
 */

const memoryStore = require("../memory-store");
const humanize = require("../humanize");
const { OutboxManager, OUTBOX_STATUS } = require("./outbox");
const { buildIdempotencyKey } = require("../capabilities/registry");
const engineConfig = require("./engine-config");
const { createRuntimeAssetStore } = require("../media/asset-store");

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class DurableScheduler {
  constructor(storage, {
    workerId = "scheduler-worker-1",
    leaseDurationMs = 30000,
    outboxManager = null,
    cancellationManager = null,
    transport = null,
    engineMode = null,
    memoryStore: customMemoryStore = null,
    assetStore = null,
  } = {}) {
    this.storage = storage;
    this.workerId = workerId;
    this.leaseDurationMs = leaseDurationMs;
    this.emergencyPaused = false;
    this.activeSock = null;
    this.timer = null;
    this.engineMode = engineMode || engineConfig.getEngineMode();
    this.memoryStore = customMemoryStore || memoryStore;
    this.assetStore = assetStore || createRuntimeAssetStore(this.engineMode);
    this.outboxManager = outboxManager || new OutboxManager(storage, {
      defaultWorkerId: workerId,
      leaseDurationMs,
      engineMode: this.engineMode,
      memoryStore: this.memoryStore,
    });
    this.cancellationManager = cancellationManager;
    this.transport = transport;
  }

  isShadow() {
    return this.engineMode === "shadow" || engineConfig.isShadow();
  }

  setEmergencyPaused(paused) {
    this.emergencyPaused = Boolean(paused);
    return this.emergencyPaused;
  }

  isEmergencyPaused() {
    return this.emergencyPaused;
  }

  agentConfig() {
    const savedEnabled = this.memoryStore.getAgentSettings().enabled;
    return {
      enabled: typeof savedEnabled === "boolean"
        ? savedEnabled
        : String(process.env.AI_AGENT_ENABLED ?? "true") !== "false",
      proactive: String(process.env.AI_AGENT_PROACTIVE ?? "true") !== "false",
      tickMs: Math.max(1_000, Number(process.env.AI_AGENT_TICK_MS) || 60_000),
      dailyLimit: Math.max(0, Number(process.env.AI_AGENT_DAILY_PROACTIVE_LIMIT) || 5),
      personCooldownMs: Math.max(0, Number(process.env.AI_AGENT_PERSON_COOLDOWN_HOURS) || 20) * HOUR,
      activeDays: Math.max(1, Number(process.env.AI_AGENT_ACTIVE_DAYS) || 7),
    };
  }

  phoneJid(phone) {
    return `${this.memoryStore.normalizePhone(phone)}@s.whatsapp.net`;
  }

  isRecentlyActive(phone, at = Date.now(), activeDays = 7) {
    const key = this.memoryStore.normalizePhone(phone);
    const person = this.memoryStore.getPerson(key);
    if (!person || !person.last_seen_wit) return false;
    const parsed = Date.parse(String(person.last_seen_wit).replace(" WIT", "Z"));
    if (!Number.isFinite(parsed)) return false;
    return at - (parsed - 9 * HOUR) <= activeDays * 24 * HOUR;
  }

  async scheduleJob({ type, fire_at, payload = {}, max_attempts = 3 }) {
    if (!type || !Number.isFinite(Number(fire_at))) return null;
    return this.storage.createJob({
      type,
      fire_at: Number(fire_at),
      payload,
      max_attempts,
      status: "scheduled",
    });
  }

  async listJobs() {
    return this.storage.listJobs({ limit: 100 });
  }

  async cancelJob(jobId) {
    return this.storage.cancelJob(jobId);
  }

  async clearJobs() {
    return this.storage.clearJobs();
  }

  todayProactiveCount(at = Date.now()) {
    const day = this.memoryStore.witDay(at);
    return this.memoryStore
      .listPeople()
      .filter((person) => person.dm?.proactive_day === day)
      .reduce((total, person) => total + (person.dm?.proactive_count || 0), 0);
  }

  canProactivelyMessage(phone, at = Date.now(), cfg = this.agentConfig()) {
    const key = this.memoryStore.normalizePhone(phone);
    if (!cfg.enabled || !cfg.proactive) return false;
    if (!this.memoryStore.canDirectMessage(key)) return false;
    if (humanize.isQuietHours(at)) return false;
    const dm = this.memoryStore.getDmMemory(key);
    if (dm.opt_out || dm.proactive_consent !== true) return false;
    if (Number.isFinite(dm.last_user_dm_at) && at >= dm.last_user_dm_at && at - dm.last_user_dm_at < HOUR) return false;
    if (dm.last_proactive_at && at - dm.last_proactive_at < cfg.personCooldownMs) return false;
    if (this.todayProactiveCount(at) >= cfg.dailyLimit) return false;
    return true;
  }

  createSocketTransport(sock) {
    if (this.isShadow()) {
      // Dalam mode shadow: ZERO pengiriman ke WhatsApp dan ZERO presence!
      return {
        send: async () => ({ messageId: "shadow_simulated", simulated: true }),
      };
    }

    return {
      send: async ({ destination, contentType = "text", payload }) => {
        let message;
        if (contentType === "image" || contentType === "sticker") {
          if (payload?.chat_id !== destination || !payload?.task_id || !payload?.asset_id) throw new Error("asset_delivery_scope_denied");
          const asset = await this.assetStore.read(payload.asset_id, { chatId: destination, taskId: payload.task_id });
          if (contentType === "sticker" && asset.mime !== "image/webp") throw new Error("asset_delivery_mime_invalid");
          if (contentType === "image" && !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)) throw new Error("asset_delivery_mime_invalid");
          message = contentType === "sticker" ? { sticker: asset.buffer } : { image: asset.buffer };
        } else if (contentType === "text") {
          message = { text: payload?.text || "" };
        } else {
          throw new Error("outbox_content_type_unsupported");
        }
        if (sock?.sendPresenceUpdate) {
          try { await sock.sendPresenceUpdate("composing", destination); } catch {}
        }
        await humanize.sleep(humanize.replyDelayMs(payload?.text || "", { min: 200, max: 600 }));
        let res = null;
        if (sock?.sendMessage) {
          res = await sock.sendMessage(destination, message);
        }
        if (contentType !== "text" && !res?.key?.id) {
          const error = new Error("asset_delivery_receipt_missing");
          error.code = "ERR_POST_SEND_UNCOMMITTED";
          throw error;
        }
        if (sock?.sendPresenceUpdate) {
          try { await sock.sendPresenceUpdate("paused", destination); } catch {}
        }
        return {
          destination,
          messageId: res?.key?.id || null,
          key: res?.key || null,
          deliveredAt: new Date().toISOString(),
        };
      },
    };
  }

  /**
   * Menjalankan satu job yang telah di-claim secara atomik melalui outbox
   */
  async executeClaimedJob(job, { sock, at = Date.now() }) {
    const cfg = this.agentConfig();
    const phone = this.memoryStore.normalizePhone(job.payload?.phone);
    if (!phone) {
      return this.storage.updateJob(job.job_id, { status: "failed", error_message: "Nomor telepon kosong" });
    }
    const jid = this.phoneJid(phone);

    // A. PENANGANAN REMINDER & FOLLOW_UP
    if (job.type === "reminder" || job.type === "follow_up") {
      const delayMs = at - job.fire_at;

      // 1. Kadaluwarsa jika terlambat lebih dari 24 jam
      if (delayMs > DAY) {
        return this.storage.updateJob(job.job_id, {
          status: "expired",
          error_message: `Pengingat terlambat ${Math.round(delayMs / HOUR)} jam (> 24 jam)`,
        });
      }

      // 2. Cek DM permissions & opt-out
      if (!this.memoryStore.canDirectMessage(phone)) {
        return this.storage.updateJob(job.job_id, {
          status: "blocked",
          error_message: `Penerima ${phone} tidak berada dalam whitelist DM`,
        });
      }
      if (this.memoryStore.getDmMemory(phone).opt_out) {
        return this.storage.updateJob(job.job_id, {
          status: "blocked",
          error_message: `Penerima ${phone} telah opt-out`,
        });
      }

      // 3. Pengecekan epoch guard sebelum pembuatan intent
      const currentEpoch = this.cancellationManager ? this.cancellationManager.getEpoch(jid) : Number(job.context_epoch || 0);

      // 4. Reminder terlambat <= 24 jam dikirim dengan penanda late
      const isLate = delayMs > MINUTE;
      let text = job.payload?.text || "Mengingatkan sesuai permintaanmu ya.";
      if (isLate) {
        text = `[Pengingat Terlambat] ${text}`;
      }

      // 5. Bangun deterministic idempotency key
      const logicalOperationId = `reminder_delivery_${job.job_id}`;
      const capabilityName = "send_message";
      const idempotencyKey = buildIdempotencyKey({
        taskId: job.job_id,
        capabilityName,
        logicalOperationId,
      });

      // 6. Transaksi atomik: outbox intent + idempotency record + update status job ke running
      const tx = await this.storage.db.transaction("write");
      try {
        await this.outboxManager.createIntent({
          jobId: job.job_id,
          destination: jid,
          contentType: "text",
          payload: { phone, text, proactive: false },
          contextEpoch: currentEpoch,
          logicalOperationId,
          capabilityName,
          idempotencyKey,
        }, tx);

        await this.storage.saveIdempotencyRecord(idempotencyKey, {
          taskId: job.job_id,
          capabilityName,
          logicalOperationId,
          resultRedacted: { destination: jid, text },
        }, tx);

        await tx.execute({
          sql: "UPDATE jobs SET status = 'running', is_late = ?, updated_at = ? WHERE job_id = ?;",
          args: [isLate ? 1 : 0, new Date().toISOString(), job.job_id],
        });

        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch {}
        throw err;
      }

      // 7. Pengiriman melalui OutboxManager sebagai SATU-SATUNYA titik delivery WhatsApp
      const transport = this.transport || (sock ? this.createSocketTransport(sock) : null);
      if (transport) {
        await this.outboxManager.drainOutbox(transport, {
          workerId: this.workerId,
          cancellationManager: this.cancellationManager,
        });
      }

      return this.storage.getJob(job.job_id);
    }

    // B. PENANGANAN PROACTIVE CHECK-IN
    if (job.type === "proactive_checkin") {
      const delayMs = at - job.fire_at;

      // 1. Check-in basi (> 1 jam atau saat jam tenang) otomatis expired
      if (delayMs > HOUR || humanize.isQuietHours(at)) {
        return this.storage.updateJob(job.job_id, {
          status: "expired",
          error_message: "Check-in basi (> 1 jam atau jam tenang)",
        });
      }

      // 2. Evaluasi gerbang proaktif
      if (!this.canProactivelyMessage(phone, at, cfg)) {
        return this.storage.updateJob(job.job_id, {
          status: "blocked",
          error_message: "Gerbang proaktif menolak pesan",
        });
      }

      const directAgent = require("../direct-agent");
      const text = await directAgent.generateProactive(phone, {
        reason: job.payload?.reason || "menyapa dan menanyakan kabar",
      });

      if (!text) {
        return this.storage.updateJob(job.job_id, {
          status: "failed",
          error_message: "Gagal membuat konten proaktif",
        });
      }

      // 3. Epoch guard
      const currentEpoch = this.cancellationManager ? this.cancellationManager.getEpoch(jid) : Number(job.context_epoch || 0);

      // 4. Bangun deterministic idempotency key
      const logicalOperationId = `proactive_delivery_${job.job_id}`;
      const capabilityName = "send_message";
      const idempotencyKey = buildIdempotencyKey({
        taskId: job.job_id,
        capabilityName,
        logicalOperationId,
      });

      // 5. Transaksi atomik: outbox intent + idempotency record + update status job ke running
      const tx = await this.storage.db.transaction("write");
      try {
        await this.outboxManager.createIntent({
          jobId: job.job_id,
          destination: jid,
          contentType: "text",
          payload: { phone, text, proactive: true },
          contextEpoch: currentEpoch,
          logicalOperationId,
          capabilityName,
          idempotencyKey,
        }, tx);

        await this.storage.saveIdempotencyRecord(idempotencyKey, {
          taskId: job.job_id,
          capabilityName,
          logicalOperationId,
          resultRedacted: { destination: jid, text },
        }, tx);

        await tx.execute({
          sql: "UPDATE jobs SET status = 'running', updated_at = ? WHERE job_id = ?;",
          args: [new Date().toISOString(), job.job_id],
        });

        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch {}
        throw err;
      }

      // 6. Pengiriman melalui OutboxManager
      const transport = this.transport || (sock ? this.createSocketTransport(sock) : null);
      if (transport) {
        await this.outboxManager.drainOutbox(transport, {
          workerId: this.workerId,
          cancellationManager: this.cancellationManager,
        });
      }

      return this.storage.getJob(job.job_id);
    }

    return this.storage.updateJob(job.job_id, { status: "failed", error_message: "Tipe job tidak dikenali" });
  }

  /**
   * Menjalankan satu job secara manual
   */
  async runJob(job, { sock = this.activeSock, at = Date.now() } = {}) {
    return this.executeClaimedJob(job, { sock, at });
  }

  /**
   * Memproses semua job jatuh tempo secara aman dengan lease & backoff retry
   */
  async runDueJobs({ sock = this.activeSock, at = Date.now() } = {}) {
    // 1. Emergency Pause menghentikan seluruh klaim dan efek samping (termasuk reminder)
    if (this.emergencyPaused) {
      return [];
    }

    const cfg = this.agentConfig();
    const dueJobs = await this.storage.listDueJobs(at, { limit: 20 });
    if (!dueJobs.length) return [];

    const results = [];

    for (const rawJob of dueJobs) {
      // 2. Reminder tetap diproses saat proactive off; selain reminder memerlukan cfg.enabled
      const isReminder = rawJob.type === "reminder" || rawJob.type === "follow_up";
      if (!isReminder && !cfg.enabled) {
        continue;
      }

      // 3. Claim job dengan lease duration
      const claimed = await this.storage.claimJob(rawJob.job_id, {
        workerId: this.workerId,
        leaseDurationMs: this.leaseDurationMs,
      });

      if (!claimed) {
        // Gagal claim (direbut worker lain atau status berubah)
        continue;
      }

      try {
        const completed = await this.executeClaimedJob(claimed, { sock, at });
        results.push(completed);
      } catch (error) {
        console.error(`[AGENT] Durable Job ${claimed.type} (${claimed.job_id}) gagal:`, error.message);

        // 4. Retry transient dengan backoff + jitter
        const nextAttempt = claimed.attempts + 1;
        if (nextAttempt >= claimed.max_attempts) {
          const failed = await this.storage.updateJob(claimed.job_id, {
            status: "failed",
            attempts: nextAttempt,
            error_message: error.message,
          });
          results.push(failed);
        } else {
          // Exponential backoff: 2^attempt * 1 minute + random jitter 0-30s
          const backoffMs = (2 ** nextAttempt) * MINUTE + Math.floor(Math.random() * 30_000);
          const retryWait = await this.storage.updateJob(claimed.job_id, {
            status: "retry_wait",
            attempts: nextAttempt,
            fire_at: at + backoffMs,
            error_message: error.message,
          });
          results.push(retryWait);
        }
      }
    }

    return results;
  }

  async maybeScheduleProactive({ at = Date.now() } = {}) {
    if (this.emergencyPaused) return null;
    const cfg = this.agentConfig();
    if (!cfg.enabled || !cfg.proactive) return null;
    if (humanize.isQuietHours(at)) return null;
    if (this.todayProactiveCount(at) >= cfg.dailyLimit) return null;

    const existingProactive = await this.storage.listJobs({ type: "proactive_checkin", status: "scheduled" });
    if (existingProactive.length > 0) return null;

    const candidate = this.memoryStore
      .listPeople()
      .filter((person) => this.canProactivelyMessage(person.phone, at, cfg))
      .filter((person) => {
        const p = this.memoryStore.getPerson(person.phone);
        if (!p?.last_seen_wit) return false;
        const parsed = Date.parse(String(p.last_seen_wit).replace(" WIT", "Z"));
        if (!Number.isFinite(parsed)) return false;
        return at - (parsed - 9 * HOUR) <= cfg.activeDays * 24 * HOUR;
      })
      .sort((a, b) => (a.dm?.last_proactive_at || 0) - (b.dm?.last_proactive_at || 0))[0];

    if (!candidate) return null;

    return this.scheduleJob({
      type: "proactive_checkin",
      fire_at: at + 1 * MINUTE + Math.floor(Math.random() * 5 * MINUTE),
      payload: { phone: candidate.phone, reason: "menyapa dan menanyakan kabar" },
    });
  }

  async tick({ sock = this.activeSock, at = Date.now() } = {}) {
    const results = await this.runDueJobs({ sock, at });
    await this.maybeScheduleProactive({ at });
    return results;
  }

  start({ sock } = {}) {
    this.stop();
    if (sock) this.activeSock = sock;
    this.timer = setInterval(() => {
      this.tick({ sock: this.activeSock }).catch((err) =>
        console.error("[AGENT] Durable scheduler tick gagal:", err.message),
      );
    }, this.agentConfig().tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this.timer;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(value) {
    if (this.isShadow()) {
      throw new Error("Mode shadow dilarang memanggil API yang menulis memoryStore atau pengaturan agen produksi");
    }
    this.memoryStore.setAgentSettings({ enabled: Boolean(value) });
    return this.agentConfig().enabled;
  }

  async status(at = Date.now()) {
    const cfg = this.agentConfig();
    const allJobs = await this.listJobs();
    const activeJobs = allJobs.filter((j) => ["scheduled", "retry_wait", "running"].includes(j.status));
    return {
      enabled: cfg.enabled,
      proactive: cfg.proactive,
      emergencyPaused: this.emergencyPaused,
      jobs: activeJobs.length,
      nextJobs: activeJobs.slice(0, 5),
      proactiveToday: this.todayProactiveCount(at),
      dailyLimit: cfg.dailyLimit,
      quiet: humanize.isQuietHours(at),
      running: Boolean(this.timer),
    };
  }
}

module.exports = {
  DurableScheduler,
};
