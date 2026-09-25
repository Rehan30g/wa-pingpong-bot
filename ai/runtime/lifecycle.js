/**
 * Runtime Lifecycle Manager untuk Fase 2
 *
 * Mengelola siklus hidup runtime bot secara mode-gated:
 * - 'legacy': Tidak menyentuh DB SQLite, migrations, maupun process lock.
 * - 'shadow': Menggunakan DB terpisah (runtime-shadow.db), tanpa write memori/jobs produksi,
 *             tanpa presence/send WhatsApp nyata.
 * - 'agent': Menggunakan DB terkonfigurasi (runtime.db), hanya mengirim efek sesudah transport siap.
 *
 * Tanggung Jawab Lifecycle:
 * 1. Mode-gating startup.
 * 2. Migrasi skema (idempotent).
 * 3. Startup recovery sebelum klaim / loop dimulai.
 * 4. ProcessLock: heartbeat berkala, kegagalan lock membatalkan durable loop tanpa menjatuhkan legacy.
 * 5. Integrasi transport readiness (menunggu transport ready sebelum memulai efek WhatsApp).
 * 6. Graceful release saat shutdown / error.
 */

const path = require("node:path");
const engineConfig = require("./engine-config");
const { createStorage } = require("./storage");
const { runStartupRecovery } = require("./recovery");
const { ProcessLock, ProcessLockError } = require("./process-lock");
const { DurableScheduler } = require("./durable-scheduler");
const { OutboxManager } = require("./outbox");
const { CancellationManager } = require("./cancellation");
const { TaskRunner } = require("./task-runner");
const { createWebFetchCapability } = require("../capabilities/web-fetch");
const { createWebSearchCapability } = require("../capabilities/web-search");
const { createMemorySearchCapability, createMemoryRememberCapability, createMemoryCorrectCapability } = require("../capabilities/memory-facts");
const { createMediaFetchCapability } = require("../capabilities/media-fetch");
const { createMessageMediaCapability } = require("../capabilities/message-media");
const { createMakeStickerCapability } = require("../capabilities/make-sticker");
const { createSendAssetCapability } = require("../capabilities/send-asset");
const { createRuntimeAssetStore } = require("../media/asset-store");
const { DurableEgressLimiter } = require("./egress-limiter");
const { InboxManager } = require("./inbox");
const { CanaryManager } = require("./canary");
const { createCapabilityRegistry } = require("../capabilities/registry");
const { registerMvpCapabilities } = require("../capabilities/mvp-capabilities");

let globalLifecycle = null;

class RuntimeLifecycle {
  constructor({
    engineMode = null,
    storage = null,
    dbPath = null,
    workerId = null,
    transport = null,
    sock = null,
    memoryStore = null,
    assetStore = null,
  } = {}) {
    this.engineMode = engineMode || engineConfig.getEngineMode();
    this.storage = storage;
    this.dbPath = dbPath;
    this.workerId = workerId || `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    this.injectedTransport = transport;
    this.sock = sock;
    this.memoryStore = memoryStore || require("../memory-store");
    this.assetStore = assetStore || createRuntimeAssetStore(this.engineMode);
    this.processLock = null;
    this.lockHeld = false;
    this.transportReady = false;
    this.durableScheduler = null;
    this.taskRunner = null;
    this.inboxManager = null;
    this.outboxManager = null;
    this.cancellationManager = null;
    this.canaryManager = null;
    this.registry = null;
    this.outboxDrainTimer = null;
    this.assetCleanupTimer = null;
    this.closeStorageFn = null;
    this.started = false;
    this.recoveryResult = null;
    this.initResult = null;
    this.lockFailure = null;
  }

  isLegacy() {
    return this.engineMode === engineConfig.ENGINE_MODES.LEGACY;
  }

  isShadow() {
    return this.engineMode === engineConfig.ENGINE_MODES.SHADOW;
  }

  isAgent() {
    return this.engineMode === engineConfig.ENGINE_MODES.AGENT;
  }

  getInboxManager() {
    return this.lockHeld ? this.inboxManager : null;
  }

  getTaskRunner() {
    return this.lockHeld ? this.taskRunner : null;
  }

  getCancellationManager() {
    return this.lockHeld ? this.cancellationManager : null;
  }

  getOutboxManager() {
    return this.lockHeld ? this.outboxManager : null;
  }

  getCanaryManager() {
    return this.canaryManager;
  }

  async bumpChatEpoch(chatId, options = {}) {
    if (!this.storage || !this.lockHeld) return 0;
    return this.storage.bumpChatEpoch(chatId, options);
  }

  getChatEpoch(chatId) {
    if (!this.storage) return 0;
    return this.storage.getChatEpoch(chatId);
  }

  async init() {
    if (this.isLegacy()) {
      this.started = true;
      const res = {
        mode: "legacy",
        lockHeld: false,
        transportReady: this.transportReady,
        started: true,
      };
      this.initResult = res;
      return res;
    }

    // Shadow & Agent Mode
    // 1. Tentukan DB storage
    if (!this.storage) {
      const targetDbPath = this.dbPath || (this.isShadow()
        ? (process.env.RUNTIME_SHADOW_DB_PATH || "./runtime-shadow.db")
        : (process.env.RUNTIME_DB_PATH || "./runtime.db"));
      const conn = await createStorage(targetDbPath);
      this.storage = conn.storage;
      this.closeStorageFn = conn.close;
    }

    // 2. Jalankan startup recovery SEBELUM klaim task/job/outbox
    this.recoveryResult = await runStartupRecovery(this.storage, {
      isTransportReady: () => this.transportReady,
      nowMs: Date.now(),
    });

    // 3. Ambil ProcessLock sebelum agent/shadow loop dimulai
    this.processLock = new ProcessLock(this.storage, {
      workerId: this.workerId,
      lockId: this.isShadow() ? "shadow_instance_lock" : "primary_instance_lock",
      leaseDurationMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });

    try {
      await this.processLock.acquire();
      this.lockHeld = true;
    } catch (err) {
      if (err instanceof ProcessLockError || err.name === "ProcessLockError" || err.code === "process_lock_held") {
        console.warn(`[RUNTIME] ProcessLock tidak diperoleh (${err.message}). Durable loop TIDAK dimulai.`);
        this.lockHeld = false;
        this.started = false;
        this.lockFailure = err;
        this.durableScheduler = null;
        this.taskRunner = null;
        this.inboxManager = null;
        this.cancellationManager = null;
        this.outboxManager = null;

        // Tutup koneksi storage segera agar tidak ada runtime DB write terbuka tanpa lock!
        if (this.closeStorageFn) {
          try {
            await this.closeStorageFn();
          } catch {}
          this.closeStorageFn = null;
          this.storage = null;
        }

        const res = {
          mode: this.engineMode,
          lockHeld: false,
          error: err,
          started: false,
        };
        this.initResult = res;
        return res;
      }
      throw err;
    }

    // 4. Instansiasi komponen resmi HANYA setelah ProcessLock berhasil diperoleh
    this.canaryManager = new CanaryManager();
    this.cancellationManager = new CancellationManager(this.storage);
    this.outboxManager = new OutboxManager(this.storage, {
      defaultWorkerId: this.workerId,
      engineMode: this.engineMode,
      memoryStore: this.memoryStore,
      canaryManager: this.canaryManager,
    });

    this.registry = createCapabilityRegistry();
    const egressLimiter = new DurableEgressLimiter(this.storage);
    registerMvpCapabilities(this.registry, { storage: this.storage });
    this.registry.registerCapability(createMemorySearchCapability({ storage: this.storage }));
    this.registry.registerCapability(createMemoryRememberCapability({ storage: this.storage }));
    this.registry.registerCapability(createMemoryCorrectCapability({ storage: this.storage }));
    this.registry.registerCapability(createWebFetchCapability({ limiter: egressLimiter }));
    this.registry.registerCapability(createWebSearchCapability({ limiter: egressLimiter }));
    this.registry.registerCapability(createMediaFetchCapability({ assetStore: this.assetStore, limiter: egressLimiter }));
    this.registry.registerCapability(createMessageMediaCapability({ assetStore: this.assetStore }));
    this.registry.registerCapability(createMakeStickerCapability({ assetStore: this.assetStore }));
    this.registry.registerCapability(createSendAssetCapability({ assetStore: this.assetStore }));

    if (typeof this.assetStore.cleanup === "function" && !this.assetCleanupTimer) {
      this.assetCleanupTimer = setInterval(() => {
        this.assetStore.cleanup().catch((error) => console.warn("[RUNTIME] Asset cleanup gagal:", error.message));
      }, 60 * 60 * 1000);
      this.assetCleanupTimer.unref?.();
    }

    this.inboxManager = new InboxManager(this.storage);

    this.durableScheduler = new DurableScheduler(this.storage, {
      workerId: this.workerId,
      engineMode: this.engineMode,
      memoryStore: this.memoryStore,
      assetStore: this.assetStore,
      outboxManager: this.outboxManager,
      cancellationManager: this.cancellationManager,
      transport: this.injectedTransport,
    });

    this.taskRunner = new TaskRunner(this.storage, {
      workerId: this.workerId,
      engineMode: this.engineMode,
      registry: this.registry,
      canaryManager: this.canaryManager,
      outboxManager: this.outboxManager,
      cancellationManager: this.cancellationManager,
    });

    this.started = true;

    // 5. Jika transport sudah siap, mulai loop durable
    if (this.transportReady || this.isShadow()) {
      await this.startDurableLoops();
    }

    const res = {
      mode: this.engineMode,
      lockHeld: true,
      transportReady: this.transportReady,
      started: true,
      recoveryResult: this.recoveryResult,
      scheduler: this.durableScheduler,
      taskRunner: this.taskRunner,
      inboxManager: this.inboxManager,
    };
    this.initResult = res;
    return res;
  }

  async startDurableLoops() {
    if (!this.lockHeld || !this.durableScheduler) return;

    // Mode shadow selalu aman dijalankan karena tidak mengirim ke WhatsApp
    // Mode agent hanya boleh mengirim jika transportReady
    if (this.isAgent() && !this.transportReady && !this.injectedTransport) {
      return;
    }

    const activeTransport = this.injectedTransport || (this.sock ? this.durableScheduler.createSocketTransport(this.sock) : null);
    if (activeTransport) {
      this.durableScheduler.transport = activeTransport;
    }
    this.durableScheduler.start({ sock: this.sock });

    if (this.taskRunner) {
      this.taskRunner.start({ intervalMs: 2_000 });
    }

    if (!this.outboxDrainTimer && activeTransport) {
      this.outboxDrainTimer = setInterval(async () => {
        try {
          await this.outboxManager.drainOutbox(activeTransport, {
            workerId: this.workerId,
            cancellationManager: this.cancellationManager,
          });
        } catch (err) {
          console.warn("[RUNTIME] Outbox draining tick error:", err.message);
        }
      }, 5_000);
      if (typeof this.outboxDrainTimer.unref === "function") {
        this.outboxDrainTimer.unref();
      }
    }
  }

  async onTransportReady({ sock = null, transport = null } = {}) {
    this.transportReady = true;
    if (sock) this.sock = sock;
    if (transport) this.injectedTransport = transport;

    if (this.isLegacy()) {
      const scheduler = require("../scheduler");
      scheduler.start({ sock: this.sock });
      return;
    }

    if (this.lockHeld && this.durableScheduler) {
      const activeTransport = this.injectedTransport || (this.sock ? this.durableScheduler.createSocketTransport(this.sock) : null);
      if (activeTransport) {
        this.durableScheduler.transport = activeTransport;
      }
      await this.startDurableLoops();
      if (activeTransport) {
        try {
          await this.outboxManager.drainOutbox(activeTransport, {
            workerId: this.workerId,
            cancellationManager: this.cancellationManager,
          });
        } catch {}
      }
    }
  }

  async onTransportClosed() {
    this.transportReady = false;
    if (this.isLegacy()) {
      const scheduler = require("../scheduler");
      scheduler.stop();
      return;
    }

    if (this.durableScheduler) {
      this.durableScheduler.stop();
    }
    if (this.taskRunner) {
      this.taskRunner.stop();
    }
    if (this.outboxDrainTimer) {
      clearInterval(this.outboxDrainTimer);
      this.outboxDrainTimer = null;
    }
  }

  async shutdown() {
    await this.onTransportClosed();
    if (this.assetCleanupTimer) {
      clearInterval(this.assetCleanupTimer);
      this.assetCleanupTimer = null;
    }

    if (this.processLock) {
      try {
        await this.processLock.release();
      } catch {}
      this.lockHeld = false;
      this.processLock = null;
    }

    if (this.closeStorageFn) {
      try {
        await this.closeStorageFn();
      } catch {}
      this.closeStorageFn = null;
      this.storage = null;
    }

    if (this.durableScheduler) {
      try { this.durableScheduler.stop(); } catch {}
      this.durableScheduler = null;
    }
    if (this.taskRunner) {
      try { this.taskRunner.stop(); } catch {}
      this.taskRunner = null;
    }
    this.inboxManager = null;
    this.outboxManager = null;
    this.cancellationManager = null;
    this.canaryManager = null;
    this.registry = null;
    this.started = false;

    if (globalLifecycle === this) {
      globalLifecycle = null;
    }
  }
}

function getGlobalLifecycle() {
  return globalLifecycle;
}

function setGlobalLifecycle(lifecycle) {
  globalLifecycle = lifecycle;
  return globalLifecycle;
}

async function shutdownGlobalLifecycle() {
  if (globalLifecycle) {
    const lc = globalLifecycle;
    globalLifecycle = null;
    await lc.shutdown();
  }
}

async function initGlobalLifecycle(options = {}) {
  if (globalLifecycle) {
    await globalLifecycle.shutdown();
    globalLifecycle = null;
  }
  globalLifecycle = new RuntimeLifecycle(options);
  const result = await globalLifecycle.init();
  globalLifecycle.initResult = result;
  return globalLifecycle;
}

module.exports = {
  RuntimeLifecycle,
  getGlobalLifecycle,
  setGlobalLifecycle,
  initGlobalLifecycle,
  shutdownGlobalLifecycle,
};
