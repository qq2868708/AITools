import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "./redact.mjs";

export const DEFAULT_DATA_DIR = fileURLToPath(new URL("./.monitor", import.meta.url));
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_ROLES = ["analyst", "reviewer", "planner"];
const VALID_STATES = ["running", "completed", "failed", "cancelled", "interrupted"];
const ERRORS = ["AUTH", "BALANCE", "RATE_LIMIT", "BAD_REQUEST", "PROVIDER", "NETWORK", "TIMEOUT", "EMPTY_RESPONSE", "INTERRUPTED", "RECORDING"];
const EVENTS = ["accepted", "routed", "redacted", "request_saved", "sent", "headers_received", "response_received", "completed", "failed", "timed_out", "cancelled", "interrupted", "response_saved", "recording_failed", "retry_created"];
const RETENTION_MS = 7 * 86400000;
const number = (value, max = 1e10) => Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), max) : 0;
const nullableNumber = value => Number.isFinite(value) && value >= 0 ? number(value) : null;
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

// This whitelist is the only path from jobs into durable storage and the browser.
// Never add task text, provider messages, free-form errors, or credentials here.
export function safeRecord(source) {
  if (!source || !UUID.test(source.id) || !VALID_STATES.includes(source.status)) {
    throw new Error("Invalid monitor record.");
  }
  const created = timestamp(source.created_at);
  if (!created) throw new Error("Invalid monitor timestamp.");
  return {
    id: source.id,
    trace_id: typeof source.trace_id === "string" && UUID.test(source.trace_id) ? source.trace_id : source.id,
    retry_of: typeof source.retry_of === "string" && UUID.test(source.retry_of) ? source.retry_of : null,
    run_id: typeof source.run_id === "string" && UUID.test(source.run_id) ? source.run_id : null,
    attempt: Math.max(1, number(source.attempt, 100)),
    route_fingerprint: typeof source.route_fingerprint === "string" && /^[a-f0-9]{64}$/.test(source.route_fingerprint) ? source.route_fingerprint : null,
    parent_id: typeof source.parent_id === "string" && UUID.test(source.parent_id) ? source.parent_id : null,
    provider: ["DeepSeek", "OpenAI", "Anthropic", "Custom"].includes(source.provider) ? source.provider : "DeepSeek",
    provider_id: typeof source.provider_id === "string" && UUID.test(source.provider_id) ? source.provider_id : null,
    key_id: typeof source.key_id === "string" && UUID.test(source.key_id) ? source.key_id : null,
    role: VALID_ROLES.includes(source.role) ? source.role : "analyst",
    model: typeof source.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(source.model) && !/^(?:sk|rk|pk)[-_]/.test(source.model) && !redact(source.model).count ? source.model : "custom-model",
    status: source.status,
    created_at: created,
    updated_at: timestamp(source.updated_at) ?? created,
    finished_at: timestamp(source.finished_at),
    input_chars: number(source.input_chars),
    output_chars: number(source.output_chars),
    max_tokens: number(source.max_tokens, 16384),
    redactions: number(source.redactions),
    prompt_tokens: nullableNumber(source.prompt_tokens),
    completion_tokens: nullableNumber(source.completion_tokens),
    total_tokens: nullableNumber(source.total_tokens),
    error_code: ERRORS.includes(source.error_code) ? source.error_code : null,
    truncated: source.truncated === true,
    http_status: Number.isInteger(source.http_status) && source.http_status >= 100 && source.http_status <= 599 ? source.http_status : null,
    sent_at: timestamp(source.sent_at),
    response_at: timestamp(source.response_at),
    body_recording: source.body_recording === true,
    body_log_error: source.body_log_error === true,
    request_truncated: source.request_truncated === true,
    events: Array.isArray(source.events) ? source.events.filter(event => event && EVENTS.includes(event.type) && timestamp(event.at)).slice(-32).map(event => ({
      type: event.type, at: timestamp(event.at),
      related_id: typeof event.related_id === "string" && UUID.test(event.related_id) ? event.related_id : null
    })) : []
  };
}

export class MonitorStore {
  constructor(directory = DEFAULT_DATA_DIR) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    this.prune();
  }

  write(source) {
    const record = safeRecord(source);
    const filename = join(this.directory, `${record.id}.json`);
    const temporary = join(this.directory, `${record.id}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, filename);
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }

  readAll(now = Date.now()) {
    const records = [];
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith(".json") || !UUID.test(file.slice(0, -5))) continue;
      try {
        const record = safeRecord(JSON.parse(readFileSync(join(this.directory, file), "utf8")));
        if (now - Date.parse(record.created_at) > RETENTION_MS) continue;
        const stale = record.status === "running" && now - Date.parse(record.updated_at) > 20000;
        records.push({ ...record, status: stale ? "interrupted" : record.status });
      } catch {
        // Partial, incompatible, or corrupt records are never forwarded to the UI.
      }
    }
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 500);
  }

  recoverInterrupted(runId) {
    let count = 0;
    for (const record of this.readAll()) {
      const alreadyRecorded = record.events.some(event => event.type === "interrupted");
      const abandoned = record.status === "running" && record.run_id && record.run_id !== runId;
      if (abandoned || (record.status === "interrupted" && !alreadyRecorded)) {
        this.write({
          ...record, status: "interrupted", error_code: "INTERRUPTED", updated_at: new Date().toISOString(),
          events: [...record.events, { type: "interrupted", at: new Date().toISOString() }]
        });
        count++;
      }
    }
    return count;
  }

  prune(now = Date.now()) {
    const files = [];
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith(".json") || !UUID.test(file.slice(0, -5))) continue;
      try {
        const record = safeRecord(JSON.parse(readFileSync(join(this.directory, file), "utf8")));
        files.push({ file, date: Date.parse(record.created_at) });
      } catch {}
    }
    files.sort((a, b) => b.date - a.date);
    for (const [index, { file, date }] of files.entries()) {
      if (index >= 500 || now - date > RETENTION_MS) {
        try { unlinkSync(join(this.directory, file)); } catch {}
      }
    }
  }
}
