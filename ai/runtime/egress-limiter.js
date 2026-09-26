class EgressLimiter {
  constructor({ perTask = 4, perHostPerMinute = 20, now = Date.now } = {}) {
    this.perTask = perTask;
    this.perHostPerMinute = perHostPerMinute;
    this.now = now;
    this.tasks = new Map();
    this.hosts = new Map();
  }

  reserve(taskId, rawUrl) {
    if (!taskId) throw new Error("egress_task_required");
    const host = new URL(rawUrl).hostname.toLowerCase();
    const timestamp = this.now();
    const taskCount = this.tasks.get(taskId) || 0;
    const hostState = this.hosts.get(host);
    const hostCount = hostState && timestamp - hostState.since < 60_000 ? hostState.count : 0;
    if (taskCount >= this.perTask) throw new Error("egress_task_quota");
    if (hostCount >= this.perHostPerMinute) throw new Error("egress_host_rate_limit");
    this.tasks.set(taskId, taskCount + 1);
    this.hosts.set(host, { since: hostCount ? hostState.since : timestamp, count: hostCount + 1 });
    if (this.tasks.size > 10000) this.tasks.delete(this.tasks.keys().next().value);
    if (this.hosts.size > 10000) this.hosts.delete(this.hosts.keys().next().value);
  }
}

class DurableEgressLimiter {
  constructor(storage, { perTask = 4, perHostPerMinute = 20, now = Date.now } = {}) {
    if (!storage || typeof storage.reserveEgress !== "function") throw new Error("egress_storage_required");
    this.storage = storage;
    this.perTask = perTask;
    this.perHostPerMinute = perHostPerMinute;
    this.now = now;
  }

  async reserve(taskId, rawUrl) {
    if (!taskId) throw new Error("egress_task_required");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !url.hostname) throw new Error("egress_url_invalid");
    return this.storage.reserveEgress({ taskId, host: url.hostname.toLowerCase(), atMs: this.now(), perTask: this.perTask, perHostPerMinute: this.perHostPerMinute });
  }
}

const sharedEgressLimiter = new EgressLimiter();
module.exports = { EgressLimiter, DurableEgressLimiter, sharedEgressLimiter };
