import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { once } from "node:events";
import { ProviderRegistry } from "./providers.mjs";
import { MonitorStore } from "./monitor-store.mjs";
import { Platform } from "./platform.mjs";
import { RequestLogs } from "./request-logs.mjs";
import { createMonitorServer } from "./monitor.mjs";

const workDirectory = fileURLToPath(new URL("./work/", import.meta.url));
mkdirSync(workDirectory, { recursive: true });

function testVault() {
  const key = randomBytes(32);
  return {
    async protect(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    async unprotectMany(values) {
      return values.map(value => {
        const data = Buffer.from(value, "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
      });
    }
  };
}
const success = text => new Response(JSON.stringify({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
}));
async function setup({ capture = false, fetchImpl = async () => success("RESPONSE_MARKER"), logVault } = {}) {
  const directory = mkdtempSync(join(workDirectory, "request-logs-test-"));
  const vault = testVault();
  const registry = new ProviderRegistry({ directory, vault, legacyKey: async () => "synthetic-primary-credential" });
  await registry.initialize();
  const provider = registry.publicData().providers[0];
  const store = new MonitorStore(join(directory, "metadata"));
  const logs = new RequestLogs({ directory, vault: logVault ?? vault });
  logs.updateSettings({ capture_bodies: capture });
  const platform = new Platform({ registry, store, requestLogs: logs, fetchImpl });
  return { directory, vault, registry, provider, store, logs, platform };
}
async function submit(fixture, input = {}) {
  const result = await fixture.platform.rpc("task_submit", {
    provider_id: fixture.provider.id, task: "REQUEST_MARKER person@example.com synthetic-primary-credential", max_tokens: 256, ...input
  });
  await fixture.platform.bridge.jobs.get(result.job_id).done;
  return result.job_id;
}

test("default logging stores lifecycle and HTTP status without any request or response text", async () => {
  const fixture = await setup();
  const id = await submit(fixture);
  const trace = await fixture.platform.rpc("task_trace", { job_id: id, include_body: true });
  assert.equal(trace.body_available, false);
  assert.equal(trace.body, undefined);
  assert.equal(trace.record.http_status, 200);
  assert.deepEqual(trace.record.events.map(event => event.type), ["accepted", "routed", "redacted", "sent", "headers_received", "response_received", "completed"]);
  const disk = readdirSync(fixture.store.directory).map(file => readFileSync(join(fixture.store.directory, file), "utf8")).join("");
  for (const value of ["REQUEST_MARKER", "RESPONSE_MARKER", "person@example.com", "synthetic-primary-credential"]) assert.ok(!disk.includes(value));
  assert.equal(readdirSync(fixture.logs.directory).length, 0);
});

test("opt-in bodies are redacted, encrypted, explicitly readable and excluded from ordinary metadata", async () => {
  const fixture = await setup({ capture: true, fetchImpl: async () => success("RESPONSE_MARKER person@example.com synthetic-primary-credential") });
  const id = await submit(fixture);
  const trace = await fixture.platform.trace(id, true);
  assert.equal(trace.body_available, true);
  assert.match(trace.body.request.task, /REQUEST_MARKER/);
  assert.match(trace.body.response.text, /RESPONSE_MARKER/);
  for (const secret of ["person@example.com", "synthetic-primary-credential"]) assert.ok(!JSON.stringify(trace).includes(secret));
  const disk = readFileSync(fixture.logs.path(id), "utf8");
  for (const value of ["REQUEST_MARKER", "RESPONSE_MARKER", "person@example.com", "synthetic-primary-credential"]) assert.ok(!disk.includes(value));
  assert.ok(!JSON.stringify(fixture.store.readAll()).includes("REQUEST_MARKER"));
  assert.ok(trace.record.events.some(event => event.type === "request_saved"));
  assert.ok(trace.record.events.some(event => event.type === "response_saved"));
  assert.equal((await fixture.platform.trace(id)).body, undefined);
});

test("manual retry creates a new attempt, keeps the failure and rotates to another key", async () => {
  let calls = 0;
  const fixture = await setup({ capture: true, fetchImpl: async () => ++calls === 1 ? new Response("SECRET_ERROR", { status: 429 }) : success("RECOVERED") });
  const second = await fixture.registry.addKey(fixture.provider.id, { label: "Second", key: "synthetic-secondary-credential" });
  const firstId = await submit(fixture);
  assert.equal(calls, 1);
  const first = await fixture.platform.trace(firstId);
  assert.equal(first.record.status, "failed");
  assert.equal(first.record.http_status, 429);
  assert.equal(first.retryable, true);
  const next = await fixture.platform.rpc("task_retry", { job_id: firstId });
  await fixture.platform.bridge.jobs.get(next.job_id).done;
  assert.notEqual(next.job_id, firstId);
  assert.equal(next.trace_id, firstId);
  assert.equal(next.attempt, 2);
  assert.equal(next.key_id, second.id);
  const trace = await fixture.platform.trace(next.job_id, true);
  assert.equal(trace.chain[0].status, "failed");
  assert.equal(trace.chain[1].status, "completed");
  assert.equal(trace.chain[1].retry_of, firstId);
  assert.equal(trace.retryable, false);
  assert.equal(calls, 2);
  await assert.rejects(fixture.platform.retry(firstId), /cannot be retried/);
  assert.ok(!JSON.stringify(trace).includes("SECRET_ERROR"));
});

test("simultaneous retry clicks result in at most one new paid request", async () => {
  let calls = 0;
  const fixture = await setup({ fetchImpl: async () => ++calls === 1 ? new Response("", { status: 500 }) : success("OK") });
  const id = await submit(fixture);
  const results = await Promise.allSettled([fixture.platform.retry(id), fixture.platform.retry(id)]);
  const good = results.find(result => result.status === "fulfilled").value;
  await fixture.platform.bridge.jobs.get(good.job_id).done;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(calls, 2);
});

test("restart marks abandoned work interrupted and permits explicit replay only from complete encrypted input", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return success("OK"); };
  const fixture = await setup({ capture: true, fetchImpl });
  const id = await submit(fixture);
  const record = fixture.store.readAll()[0];
  fixture.store.write({ ...record, status: "running", finished_at: null,
    events: record.events.filter(event => !["completed", "response_saved"].includes(event.type)) });
  const restarted = new Platform({
    registry: new ProviderRegistry({ directory: fixture.directory, vault: fixture.vault }),
    store: fixture.store, fetchImpl
  });
  await restarted.initialize();
  assert.equal(calls, 1, "restart must not automatically repeat the provider request");
  const before = await restarted.trace(id);
  assert.equal(before.record.status, "interrupted");
  assert.equal(before.record.error_code, "INTERRUPTED");
  assert.equal(before.replay_source, "encrypted_record");
  assert.equal(before.retryable, true);
  assert.ok(before.record.events.some(event => event.type === "interrupted"));
  const next = await restarted.retry(id);
  await restarted.bridge.jobs.get(next.job_id).done;
  assert.equal(calls, 2);
  assert.equal((await restarted.trace(next.job_id)).record.status, "completed");
});

test("metadata-only history cannot be replayed after its process memory is lost", async () => {
  const fixture = await setup({ fetchImpl: async () => new Response("", { status: 500 }) });
  const id = await submit(fixture);
  const restarted = new Platform({ registry: fixture.registry, store: fixture.store });
  await restarted.initialize();
  assert.equal((await restarted.trace(id)).retryable, false);
  await assert.rejects(restarted.retry(id), /cannot be retried/);
});

test("truncated stored requests cannot be replayed after restart", async () => {
  const fixture = await setup({ capture: true, fetchImpl: async () => new Response("", { status: 500 }) });
  const id = await submit(fixture, { task: "X".repeat(65000) });
  const trace = await fixture.platform.trace(id, true);
  assert.equal(trace.body.request_truncated, true);
  assert.equal(trace.body.request.task.length, 64000);
  assert.equal(trace.retryable, true, "complete in-memory request is still usable");
  const restarted = new Platform({ registry: fixture.registry, store: fixture.store });
  await restarted.initialize();
  assert.equal((await restarted.trace(id)).retryable, false);
});

test("failure to record the initial request prevents the provider call", async () => {
  let calls = 0;
  const fixture = await setup({ capture: true,
    fetchImpl: async () => { calls++; return success("OK"); },
    logVault: { protect: async () => { throw new Error("fixture disk failure"); }, unprotectMany: async () => [] }
  });
  const id = await submit(fixture);
  const record = fixture.store.readAll()[0];
  assert.equal(calls, 0);
  assert.equal(record.status, "failed");
  assert.equal(record.error_code, "RECORDING");
  assert.equal(record.body_log_error, true);
  assert.equal(record.id, id);
  assert.ok(!record.events.some(event => event.type === "sent"));
});

test("failure to save a response does not turn successful provider work into a failed task", async () => {
  const vault = testVault();
  let writes = 0;
  const fixture = await setup({ capture: true, logVault: {
    ...vault, protect: value => { if (++writes > 1) throw new Error("fixture response write failure"); return vault.protect(value); }
  } });
  const id = await submit(fixture);
  const record = fixture.store.readAll()[0];
  assert.equal(record.status, "completed");
  assert.equal(record.body_log_error, true);
  assert.match(fixture.platform.bridge.result(id).result.text, /RESPONSE_MARKER/);
  assert.equal(fixture.platform.bridge.monitorHealthy, false);
});

test("changing the upstream endpoint blocks replay to an unexpected destination", async () => {
  const fixture = await setup({ fetchImpl: async () => new Response("", { status: 500 }) });
  const id = await submit(fixture);
  await fixture.registry.update(fixture.provider.id, { base_url: "https://another.example/v1" });
  await assert.rejects(fixture.platform.retry(id), /endpoint changed/);
});

test("logging toggle affects new requests only and pruning removes expired encrypted bodies", async () => {
  const fixture = await setup();
  const original = await submit(fixture);
  fixture.logs.updateSettings({ capture_bodies: true });
  const recorded = await submit(fixture);
  fixture.logs.updateSettings({ capture_bodies: false });
  assert.equal(fixture.logs.has(original), false);
  assert.equal(fixture.logs.has(recorded), true);
  const old = fixture.store.readAll().find(job => job.id === recorded);
  fixture.store.write({ ...old, created_at: new Date(Date.now() - 8 * 86400000).toISOString() });
  fixture.platform.prune();
  assert.equal(fixture.logs.has(recorded), false);
});

test("body access, logging changes and retries require authentication; ordinary exports remain metadata-only", async () => {
  const fixture = await setup({ capture: true });
  const id = await submit(fixture);
  const server = createMonitorServer(fixture.store, fixture.platform);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, body, auth = false) => fetch(`${origin}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(auth ? { "X-Platform-Token": fixture.platform.token } : {}) }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await request("/api/rpc", "POST", { action: "task_trace", args: { job_id: id, include_body: true } })).status, 403);
    assert.equal((await request("/api/logging", "PATCH", { capture_bodies: false })).status, 403);
    const trace = await (await request("/api/rpc", "POST", { action: "task_trace", args: { job_id: id, include_body: true } }, true)).json();
    assert.match(trace.body.request.task, /REQUEST_MARKER/);
    const exported = await (await fetch(`${origin}/api/export`)).text();
    assert.ok(!exported.includes("REQUEST_MARKER"));
    assert.ok(!exported.includes("RESPONSE_MARKER"));
    assert.equal((await fetch(`${origin}/.platform/request-bodies/${id}.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("a UUID-shaped saved API key cannot leak through a parent-task identifier", async () => {
  let calls = 0;
  const fixture = await setup({ fetchImpl: async () => { calls++; return success("OK"); } });
  const uuidKey = "f5eaf9f9-3193-4dbd-96db-cc3295fd1b0f";
  await fixture.registry.addKey(fixture.provider.id, { label: "UUID credential", key: uuidKey });
  await assert.rejects(fixture.platform.rpc("task_submit", {
    provider_id: fixture.provider.id, parent_id: uuidKey, task: "Test"
  }), /must not contain credentials/);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(fixture.store.readAll()).includes(uuidKey));
});
