import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { once } from "node:events";
import { ProviderRegistry } from "./providers.mjs";
import { Platform } from "./platform.mjs";
import { MonitorStore } from "./monitor-store.mjs";
import { createMonitorServer } from "./monitor.mjs";
import { buildRequest, parseResponse, validateBaseUrl } from "./provider-adapters.mjs";
import { windowsVault } from "./vault.mjs";
import { acquireServiceLock } from "./service-lock.mjs";

const root = fileURLToPath(new URL("./work/", import.meta.url));
mkdirSync(root, { recursive: true });
const temp = () => mkdtempSync(join(root, "platform-test-"));
function testVault() {
  const key = randomBytes(32);
  return {
    async protect(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    async unprotectMany(values) {
      return values.map(value => {
        const data = Buffer.from(value, "base64");
        const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        cipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
      });
    }
  };
}
const fields = name => ({ name, protocol: "openai-chat", base_url: "https://example.test/v1", models: ["test-model"], default_model: "test-model", key_policy: "round_robin" });
async function registry(options = {}) {
  const instance = new ProviderRegistry({ directory: temp(), legacyKey: async () => "", vault: testVault(), ...options });
  await instance.initialize();
  return instance;
}

test("provider and key CRUD persists only encrypted secrets and returns public metadata", async () => {
  const vault = testVault();
  const config = await registry({ vault });
  const { id } = await config.create(fields("Provider A"));
  const one = await config.addKey(id, { label: "First", key: "first-secret-credential" });
  const two = await config.addKey(id, { label: "Second", key: "second-secret-credential" });
  await assert.rejects(config.addKey(id, { label: "Duplicate", key: "first-secret-credential" }), /already exists/);
  await config.updateKey(id, one.id, { label: "Renamed", key: "replacement-secret-value" });
  await config.setDefault(id);
  const publicData = JSON.stringify(config.publicData());
  const disk = readFileSync(config.file, "utf8");
  for (const secret of ["first-secret-credential", "second-secret-credential", "replacement-secret-value"]) {
    assert.ok(!publicData.includes(secret));
    assert.ok(!disk.includes(secret));
  }
  assert.ok(!publicData.includes("encrypted"));
  assert.ok(!publicData.includes("fingerprint"));
  const restored = new ProviderRegistry({ directory: config.directory, vault });
  const route = await restored.acquire({ provider_id: id, key_id: one.id });
  assert.equal(route.key, "replacement-secret-value");
  assert.equal(route.key_id, one.id);
  await config.removeKey(id, two.id);
  await config.remove(id);
  assert.ok(!config.publicData().providers.some(p => p.id === id));
});

test("serialized rotation, explicit routing, disabled keys, wrong-provider isolation and default", async () => {
  const config = await registry();
  const a = await config.create(fields("Provider A"));
  const b = await config.create(fields("Provider B"));
  const a1 = await config.addKey(a.id, { label: "A1", key: "credential-a-one" });
  const a2 = await config.addKey(a.id, { label: "A2", key: "credential-a-two" });
  const b1 = await config.addKey(b.id, { label: "B1", key: "credential-b-one" });
  await config.setDefault(a.id);
  const routes = await Promise.all([config.acquire({}), config.acquire({}), config.acquire({})]);
  assert.deepEqual(routes.map(route => route.key_id), [a1.id, a2.id, a1.id]);
  assert.equal((await config.acquire({ provider_id: a.id, key_id: a2.id })).key, "credential-a-two");
  await assert.rejects(config.acquire({ provider_id: a.id, key_id: b1.id }), /another provider/);
  await config.updateKey(a.id, a1.id, { enabled: false });
  assert.equal((await config.acquire({ provider_id: a.id })).key_id, a2.id);
  await assert.rejects(config.acquire({ provider_id: a.id, key_id: a1.id }), /unavailable/);
  await config.update(a.id, { key_policy: "priority" });
  assert.equal((await config.acquire({ provider_id: a.id })).key_id, a2.id);
  await config.update(a.id, { enabled: false });
  await assert.rejects(config.acquire({ provider_id: a.id }), /disabled/);
});

test("credential health controls automatic selection and endpoint changes reset stale validation", async () => {
  const config = await registry();
  const p = await config.create(fields("Health checks"));
  const k = await config.addKey(p.id, { label: "Primary", key: "credential-primary" });
  const route = await config.acquire({ provider_id: p.id });
  await config.noteResult(route, "AUTH");
  await assert.rejects(config.acquire({ provider_id: p.id }), /No enabled/);
  await config.updateKey(p.id, k.id, { enabled: true });
  await config.noteResult(route, "RATE_LIMIT");
  await assert.rejects(config.acquire({ provider_id: p.id }), /No enabled/);
  await config.update(p.id, { base_url: "https://another.example/v1" });
  const current = await config.acquire({ provider_id: p.id });
  await config.noteResult(route, "AUTH");
  assert.equal(config.publicData().providers.find(item => item.id === p.id).keys[0].error_code, null);
  await config.noteResult(current);
  assert.equal(config.publicData().providers.find(item => item.id === p.id).keys[0].health, "healthy");
});

test("three protocols build correct routes, credential headers and normalize response usage", () => {
  const messages = [{ role: "system", content: "Policy" }, { role: "user", content: "Task" }];
  const input = { model: "test-model", messages, max_tokens: 512 };
  const chat = buildRequest({ protocol: "openai-chat", base_url: "https://api.deepseek.com", key: "fixture" }, input);
  assert.equal(chat.url, "https://api.deepseek.com/chat/completions");
  assert.equal(chat.body.thinking.type, "disabled");
  assert.equal(chat.headers.Authorization, "Bearer fixture");
  const responses = buildRequest({ protocol: "openai-responses", base_url: "https://api.openai.com/v1", key: "fixture" }, input);
  assert.equal(responses.url, "https://api.openai.com/v1/responses");
  assert.equal(responses.body.max_output_tokens, 512);
  assert.equal(responses.body.store, false);
  const anthropic = buildRequest({ protocol: "anthropic", base_url: "https://api.anthropic.com/v1", key: "fixture" }, input);
  assert.equal(anthropic.headers["x-api-key"], "fixture");
  assert.equal(anthropic.body.system, "Policy");
  assert.equal(anthropic.body.messages.length, 1);
  assert.equal(parseResponse("anthropic", { content: [{ type: "text", text: "OK" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }).usage.total_tokens, 20);
  const parsed = parseResponse("openai-responses", { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], status: "incomplete", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  assert.equal(parsed.text, "OK");
  assert.equal(parsed.truncated, true);
  assert.throws(() => validateBaseUrl("https://user:key@example.com/v1"));
  assert.throws(() => validateBaseUrl("http://example.com/v1"));
  assert.throws(() => validateBaseUrl("https://example.com/v1?key=secret"));
  assert.throws(() => validateBaseUrl("https://example.com/v1/chat/completions"));
});

test("OpenAI-compatible protocols omit unset budgets and preserve explicit budgets above the old ceiling", () => {
  const messages = [{ role: "user", content: "Review" }];
  for (const [protocol, base_url, field] of [
    ["openai-chat", "https://api.deepseek.com", "max_tokens"],
    ["openai-chat", "https://api.openai.com/v1", "max_completion_tokens"],
    ["openai-responses", "https://example.invalid/v1", "max_output_tokens"]
  ]) {
    const route = { protocol, base_url, key: "synthetic-key" };
    const unlimited = buildRequest(route, { model: "test-model", messages });
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) assert.equal(Object.hasOwn(unlimited.body, key), false);
    const explicit = buildRequest(route, { model: "test-model", messages, max_tokens: 65536 });
    assert.equal(explicit.body[field], 65536);
  }
});

test("key validation does not send completions or return upstream secret/error bodies", async () => {
  let endpoint;
  const config = await registry({ fetchImpl: async (url, options) => {
    endpoint = url;
    assert.equal(options.redirect, "error");
    return new Response("credential-secret-do-not-return", { status: 401 });
  } });
  const p = await config.create(fields("Validation"));
  const k = await config.addKey(p.id, { label: "Key", key: "credential-secret-do-not-return" });
  const result = await config.testKey(p.id, k.id);
  assert.equal(endpoint, "https://example.test/v1/models");
  assert.equal(result.error_code, "AUTH");
  assert.ok(!JSON.stringify(result).includes("credential-secret-do-not-return"));
});

test("dispatch attributes selected provider/key, redacts all saved keys and survives client disconnect", async () => {
  const config = await registry();
  const p = await config.create(fields("Execution"));
  const k = await config.addKey(p.id, { label: "Active", key: "alpha-private-credential" });
  await config.addKey(p.id, { label: "Other", key: "beta-private-credential" });
  const store = new MonitorStore(temp());
  let requests = 0;
  const platform = new Platform({ registry: config, store, fetchImpl: async (_, options) => {
    requests++;
    assert.ok(!options.body.includes("alpha-private-credential"));
    assert.ok(!options.body.includes("beta-private-credential"));
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK beta-private-credential" }, finish_reason: "stop" }], usage: { total_tokens: 12 } }));
  } });
  const submitted = await platform.rpc("task_submit", { provider_id: p.id, key_id: k.id, task: "Review alpha-private-credential beta-private-credential" });
  await platform.bridge.jobs.get(submitted.job_id).done;
  const result = await platform.rpc("task_result", { job_id: submitted.job_id });
  assert.ok(!JSON.stringify(result).includes("beta-private-credential"));
  assert.equal(requests, 1);
  const metadata = store.readAll()[0];
  assert.equal(metadata.provider_id, p.id);
  assert.equal(metadata.key_id, k.id);
});

test("management mutations require local session token and neither API nor disk exposes plaintext", async () => {
  const config = await registry();
  const platform = new Platform({ registry: config, store: new MonitorStore(temp()) });
  const server = createMonitorServer(platform.store, platform);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const mutation = (path, method, value, token = platform.token) => fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", "X-Platform-Token": token },
    body: JSON.stringify(value)
  });
  try {
    assert.equal((await mutation("/api/providers", "POST", fields("Denied"), "")).status, 403);
    const created = await (await mutation("/api/providers", "POST", fields("Through API"))).json();
    const key = await (await mutation(`/api/providers/${created.id}/keys`, "POST", { label: "API key", key: "unique-sensitive-credential" })).json();
    assert.ok(key.id);
    const publicBody = await (await fetch(`${base}/api/providers`)).text();
    assert.ok(!publicBody.includes("unique-sensitive-credential"));
    assert.ok(!publicBody.includes("encrypted"));
    assert.ok(!readFileSync(config.file, "utf8").includes("unique-sensitive-credential"));
    assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/.platform/providers.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("real Windows DPAPI vault round-trip never writes plaintext into persisted provider configuration", { skip: process.platform !== "win32" }, async () => {
  const config = await registry({ vault: windowsVault, legacyKey: async () => "synthetic-migration-key" });
  const data = config.publicData();
  const selected = await config.acquire({ provider_id: data.providers[0].id });
  assert.equal(selected.key, "synthetic-migration-key");
  assert.ok(!readFileSync(config.file, "utf8").includes("synthetic-migration-key"));
  const reloaded = new ProviderRegistry({ directory: config.directory, vault: windowsVault });
  const again = await reloaded.acquire({ provider_id: data.providers[0].id });
  assert.equal(again.key, "synthetic-migration-key");
});

test("one platform owns the provider store at a time", () => {
  const directory = temp();
  const release = acquireServiceLock(directory);
  assert.throws(() => acquireServiceLock(directory), /already running/);
  release();
  acquireServiceLock(directory)();
});

test("known keys cannot leak through user-supplied provider labels or model overrides", async () => {
  const config = await registry();
  const provider = await config.create(fields("Safe metadata"));
  const key = await config.addKey(provider.id, { label: "Key", key: "not-a-standard-prefix-secret" });
  await assert.rejects(config.update(provider.id, { name: "not-a-standard-prefix-secret" }), /must not contain/);
  await assert.rejects(config.updateKey(provider.id, key.id, { label: "not-a-standard-prefix-secret" }), /must not contain/);
  await assert.rejects(config.acquire({ provider_id: provider.id, model: "not-a-standard-prefix-secret" }), /Invalid model/);
  assert.ok(!JSON.stringify(config.publicData()).includes("not-a-standard-prefix-secret"));
});
