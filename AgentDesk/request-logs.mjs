import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { windowsVault } from "./vault.mjs";
import { UUID } from "./monitor-store.mjs";
import { redact } from "./redact.mjs";

const BODY_LIMIT = 64000;
const iso = () => new Date().toISOString();
function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch {} }
}

export class RequestLogs {
  constructor({ directory, vault = windowsVault }) {
    this.directory = join(directory, "request-bodies");
    this.settingsFile = join(directory, "logging.json");
    this.vault = vault;
    mkdirSync(this.directory, { recursive: true });
    this.settings = existsSync(this.settingsFile)
      ? JSON.parse(readFileSync(this.settingsFile, "utf8")) : { capture_bodies: false };
    if (typeof this.settings.capture_bodies !== "boolean") throw new Error("Invalid logging settings.");
  }

  publicSettings() {
    return { capture_bodies: this.settings.capture_bodies, body_limit_chars: BODY_LIMIT, retention_days: 7, max_records: 500 };
  }

  updateSettings(input) {
    if (typeof input.capture_bodies !== "boolean") throw new Error("capture_bodies must be a boolean.");
    const settings = { capture_bodies: input.capture_bodies, changed_at: iso() };
    atomicWrite(this.settingsFile, settings);
    this.settings = settings;
    return this.publicSettings();
  }

  path(id) {
    if (!UUID.test(id)) throw new Error("Invalid request ID.");
    return join(this.directory, `${id}.json`);
  }

  has(id) { return existsSync(this.path(id)); }

  boundedInput(input, secrets) {
    let remaining = BODY_LIMIT;
    let truncated = false;
    const text = value => {
      const safe = redact(value ?? "", secrets).text;
      const result = safe.slice(0, remaining);
      if (result.length < safe.length) truncated = true;
      remaining -= result.length;
      return result;
    };
    const request = {
      provider_id: input.provider_id, model: input.model, role: input.role,
      max_tokens: input.max_tokens, parent_id: input.parent_id,
      task: text(input.task), context: text(input.context),
      history: (input.history ?? []).map(message => ({ role: message.role, content: text(message.content) }))
    };
    return { request, truncated };
  }

  async save(id, payload) {
    const encrypted = await this.vault.protect(JSON.stringify(payload));
    atomicWrite(this.path(id), { version: 1, id, encrypted });
  }

  async begin(job, input, secrets) {
    const bounded = this.boundedInput(input, secrets);
    const payload = { version: 1, request: bounded.request, request_truncated: bounded.truncated,
      response: null, response_truncated: false, created_at: job.created_at };
    await this.save(job.id, payload);
    return payload;
  }

  async complete(job, payload, secrets) {
    const text = redact(job.result?.text ?? "", secrets).text;
    await this.save(job.id, {
      ...payload,
      response: job.result ? { text: text.slice(0, BODY_LIMIT) } : null,
      response_truncated: text.length > BODY_LIMIT || job.result?.truncated === true,
      finished_at: job.finished_at, status: job.status
    });
  }

  async read(id, secrets = []) {
    if (!this.has(id)) return null;
    let payload;
    try {
      const stored = JSON.parse(readFileSync(this.path(id), "utf8"));
      if (stored.version !== 1 || stored.id !== id || typeof stored.encrypted !== "string") throw new Error();
      const [plaintext] = await this.vault.unprotectMany([stored.encrypted]);
      payload = JSON.parse(plaintext);
      if (payload.version !== 1 || typeof payload.request?.task !== "string") throw new Error();
    } catch { throw new Error("Cannot decrypt the recorded request for this Windows account."); }
    const bounded = this.boundedInput(payload.request, secrets);
    return {
      request: bounded.request,
      request_truncated: payload.request_truncated === true || bounded.truncated,
      response: typeof payload.response?.text === "string" ? { text: redact(payload.response.text, secrets).text.slice(0, BODY_LIMIT) } : null,
      response_truncated: payload.response_truncated === true,
      created_at: payload.created_at, finished_at: payload.finished_at ?? null
    };
  }

  prune(retainedIds) {
    const retained = new Set(retainedIds);
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith(".json") && UUID.test(name.slice(0, -5)) && !retained.has(name.slice(0, -5))) {
        try { unlinkSync(join(this.directory, name)); } catch {}
      }
    }
  }
}
