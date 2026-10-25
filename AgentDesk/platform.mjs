import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { ProviderRegistry } from "./providers.mjs";
import { MonitorStore } from "./monitor-store.mjs";
import { Bridge } from "./bridge.mjs";
import { RequestLogs } from "./request-logs.mjs";

export class Platform {
  constructor({ registry = new ProviderRegistry(), store = new MonitorStore(), fetchImpl = fetch, requestLogs = null } = {}) {
    this.registry = registry;
    this.store = store;
    this.token = randomBytes(32).toString("hex");
    this.runId = randomUUID();
    this.requestLogs = requestLogs ?? new RequestLogs({ directory: registry.directory, vault: registry.vault });
    this.retrying = new Set();
    this.bridge = new Bridge({
      monitor: store, fetchImpl,
      resolveProvider: input => registry.acquire(input),
      onResult: (route, code) => registry.noteResult(route, code),
      requestLogs: this.requestLogs, runId: this.runId
    });
  }

  async initialize() {
    await this.registry.initialize();
    this.store.recoverInterrupted(this.runId);
    this.prune();
  }

  prune() {
    this.store.prune();
    this.requestLogs.prune(this.store.readAll().map(job => job.id));
  }

  authorized(token) {
    if (typeof token !== "string" || token.length !== this.token.length) return false;
    const supplied = Buffer.from(token);
    return supplied.length === 64 && timingSafeEqual(supplied, Buffer.from(this.token));
  }

  requireIdle(providerId, keyId) {
    if ([...this.bridge.jobs.values()].some(job => job.status === "running" && job.provider_id === providerId && (!keyId || job.key_id === keyId))) {
      throw new Error("This provider or key has an active task. Wait or cancel it before deleting.");
    }
  }

  async trace(jobId, includeBody = false) {
    const records = this.store.readAll();
    const record = records.find(job => job.id === jobId);
    if (!record) throw new Error("Request record not found or expired.");
    const chain = records.filter(job => job.trace_id === record.trace_id)
      .sort((a, b) => a.attempt - b.attempt || a.created_at.localeCompare(b.created_at));
    const local = this.bridge.jobs.get(jobId);
    const storedBody = this.requestLogs.has(jobId);
    const result = {
      record, chain,
      body_available: storedBody,
      body_pending: local?.finalizing === true || local?.preparing === true,
      retryable: ["failed", "cancelled", "interrupted"].includes(record.status) &&
        !local?.finalizing && !local?.preparing && chain.at(-1)?.id === record.id &&
        !chain.some(job => job.status === "running" || job.status === "completed") &&
        Boolean(local?.retry_input || (storedBody && !record.request_truncated)) && record.attempt < 10,
      replay_source: local?.retry_input ? "memory" : storedBody && !record.request_truncated ? "encrypted_record" : null
    };
    if (includeBody && storedBody) result.body = await this.requestLogs.read(jobId, await this.registry.secrets());
    return result;
  }

  async retry(jobId, keyId) {
    if (this.retrying.has(jobId)) throw new Error("A retry is already being prepared.");
    this.retrying.add(jobId);
    try {
      const trace = await this.trace(jobId);
      if (!trace.retryable) throw new Error("This request cannot be retried. Use the latest failed attempt with an available complete request body.");
      const original = trace.record;
      const provider = this.registry.provider(original.provider_id);
      const fingerprint = createHash("sha256").update(`${provider.protocol}\n${provider.base_url}`).digest("hex");
      if (fingerprint !== original.route_fingerprint) throw new Error("Provider endpoint changed. Review the destination and submit a new task.");
      let input = this.bridge.jobs.get(jobId)?.retry_input;
      if (!input) {
        const saved = await this.requestLogs.read(jobId, await this.registry.secrets());
        if (!saved || saved.request_truncated) throw new Error("A complete recorded request is unavailable.");
        input = saved.request;
      }
      const args = { ...input };
      if (keyId) args.key_id = keyId;
      const submitted = await this.bridge.submit(args, {
        trace_id: original.trace_id, retry_of: original.id, attempt: original.attempt + 1
      });
      const local = this.bridge.jobs.get(jobId);
      if (local) {
        this.bridge.event(local, "retry_created", submitted.job_id);
        this.bridge.record(local);
      } else {
        this.store.write({ ...original, updated_at: new Date().toISOString(), events: [
          ...original.events, { type: "retry_created", at: new Date().toISOString(), related_id: submitted.job_id }
        ] });
      }
      return submitted;
    } finally { this.retrying.delete(jobId); }
  }

  async rpc(action, args = {}) {
    if (action === "provider_list") return this.registry.publicData();
    if (action === "deepseek_status") {
      const data = this.registry.publicData();
      const provider = data.providers.find(p => new URL(p.base_url).hostname === "api.deepseek.com");
      return { configured: Boolean(provider?.enabled && provider.keys.some(k => k.enabled)),
        default_model: provider?.default_model ?? null, monitor_enabled: true,
        monitor_healthy: this.bridge.monitorHealthy, providers: data.providers.length,
        jobs: [...this.bridge.jobs.values()].map(({ id, status, provider_id, key_id }) => ({ id, status, provider_id, key_id })) };
    }
    if (action === "task_submit") return this.bridge.submit(args);
    if (action === "task_trace") return this.trace(args.job_id, args.include_body === true);
    if (action === "task_retry") return this.retry(args.job_id, args.key_id);
    if (action === "deepseek_submit") {
      const provider = this.registry.publicData().providers.find(p => new URL(p.base_url).hostname === "api.deepseek.com");
      if (!provider) throw new Error("No DeepSeek provider is configured.");
      return this.bridge.submit({ ...args, provider_id: provider.id });
    }
    if (action === "task_result" || action === "deepseek_result") return this.bridge.result(args.job_id);
    if (action === "task_cancel" || action === "deepseek_cancel") return this.bridge.cancel(args.job_id);
    throw new Error("Unknown action.");
  }
}
