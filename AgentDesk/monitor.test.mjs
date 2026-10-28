import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { redact } from "./redact.mjs";
import { MonitorStore, safeRecord } from "./monitor-store.mjs";
import { createMonitorServer } from "./monitor.mjs";
import { Bridge } from "./bridge.mjs";

const root = fileURLToPath(new URL("./work/", import.meta.url));
mkdirSync(root, { recursive: true });
const temp = () => mkdtempSync(join(root, "monitor-test-"));
const base = () => ({
  id: randomUUID(), status: "running", created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), role: "reviewer", model: "deepseek-flash"
});
const requestWithHeaders = (port, path, headers, method = "GET") => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path, headers, method }, response => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", chunk => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
  });
  req.on("error", reject);
  req.end();
});

test("outgoing filter removes known key, credentials, personal contacts, URLs and paths", () => {
  const sensitive = [
    "sk-1234567890abcdefghijkl", "exact-private-key", "person@example.com",
    "13812345678", "+1 415-555-1212", "C:\\Users\\Private\\source.js",
    "/home/private/project.txt", "https://private.example.com/?token=private",
    "10.0.0.123", "ghp_1234567890abcdefgh", "eyJabc.eyJdef.signature"
  ];
  const text = `${sensitive.join("\n")}\npassword="veryprivate"\napi_key: 'anotherprivate'\nBearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nSUPERPRIVATE\n-----END PRIVATE KEY-----`;
  const result = redact(text, ["exact-private-key"]);
  for (const value of [...sensitive, "veryprivate", "anotherprivate", "abcdefghijklmnop", "SUPERPRIVATE"]) {
    assert.ok(!result.text.includes(value), `leaked fixture: ${value}`);
  }
  assert.ok(result.count >= 15);
});

test("durable schema drops all free text and invalid provider usage", () => {
  const safe = safeRecord({
    ...base(), task: "SECRET_TASK", result: "SECRET_RESPONSE", error: "SECRET_ERROR",
    password: "SECRET_KEY", model: "sk-SECRET_MODEL", parent_id: "SECRET_PARENT",
    total_tokens: "SECRET_USAGE", error_code: "SECRET_ERROR_CODE",
    response_status: "SECRET_STATUS", finish_reason: "SECRET_FINISH",
    content_types: ["reasoning", "SECRET_TYPE"], reasoning_tokens: "SECRET_REASONING",
    raw_response: "SECRET_RAW_RESPONSE"
  });
  assert.ok(!JSON.stringify(safe).includes("SECRET"));
  assert.equal(safe.total_tokens, null);
  assert.equal(safe.model, "custom-model");
  assert.equal(safe.response_status, "other");
  assert.equal(safe.finish_reason, "other");
  assert.deepEqual(safe.content_types, ["reasoning", "other"]);
  assert.equal(safe.reasoning_tokens, null);
});

test("answerless responses retain safe diagnostics and distinguish output limits without retrying", async t => {
  const usage = { input_tokens: 600, output_tokens: 4096, total_tokens: 4696,
    output_tokens_details: { reasoning_tokens: 4096 } };
  const cases = [
    {
      name: "Responses reasoning exhausts the budget before an answer", protocol: "openai-responses",
      data: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", summary: [{ text: "PRIVATE_REASONING" }] }], usage },
      error: "OUTPUT_LIMIT", finish: "max_output_tokens", types: ["reasoning"], reasoning: 4096, truncated: true
    },
    {
      name: "Chat reasoning exhausts the budget before an answer", protocol: "openai-chat",
      data: { choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "PRIVATE_REASONING" } }],
        usage: { prompt_tokens: 600, completion_tokens: 4096, total_tokens: 4696, completion_tokens_details: { reasoning_tokens: 4096 } } },
      error: "OUTPUT_LIMIT", finish: "length", types: ["reasoning"], reasoning: 4096, truncated: true
    },
    {
      name: "Anthropic thinking exhausts the budget before an answer", protocol: "anthropic",
      data: { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }], usage },
      error: "OUTPUT_LIMIT", finish: "max_tokens", types: ["thinking"], reasoning: null, truncated: true
    },
    {
      name: "A completed reasoning-only response does not imply a budget failure", protocol: "openai-responses",
      data: { status: "completed", output: [{ type: "reasoning", summary: [{ text: "PRIVATE_REASONING" }] }], usage },
      error: "EMPTY_RESPONSE", finish: "completed", types: ["reasoning"], reasoning: 4096, truncated: false
    },
    {
      name: "A refusal is visible as a content type without storing its text", protocol: "openai-responses",
      data: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "PRIVATE_REFUSAL" }] }], usage },
      error: "EMPTY_RESPONSE", finish: "completed", types: ["message", "refusal"], reasoning: 4096, truncated: false
    },
    {
      name: "A failed provider response retains metadata and stays a failure", protocol: "openai-responses",
      data: { status: "failed", error: { message: "PRIVATE_PROVIDER_ERROR" },
        output: [{ type: "message", content: [{ type: "output_text", text: "PRIVATE_ANSWER" }] }], usage },
      error: "PROVIDER", finish: "failed", types: ["message", "output_text"], reasoning: 4096, truncated: false
    },
    {
      name: "A partial answer remains available with its truncation flag", protocol: "openai-responses",
      data: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "PRIVATE_PARTIAL_ANSWER" }] }], usage },
      error: null, finish: "max_output_tokens", types: ["message", "output_text"], reasoning: 4096, truncated: true
    }
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const directory = temp();
    const store = new MonitorStore(directory);
    let calls = 0;
    const bridge = new Bridge({
      monitor: store,
      resolveProvider: async () => ({ key: "synthetic-secret", protocol: fixture.protocol,
        base_url: "https://example.invalid/v1", model: "test-model", provider: "Custom" }),
      fetchImpl: async () => { calls++; return new Response(JSON.stringify(fixture.data)); }
    });
    const { job_id } = await bridge.submit({ task: "PRIVATE_TASK", max_tokens: 4096 });
    await bridge.jobs.get(job_id).done;
    const result = bridge.result(job_id);
    const record = store.readAll()[0];
    assert.equal(calls, 1);
    assert.equal(result.status, fixture.error ? "failed" : "completed");
    assert.equal(record.http_status, 200);
    assert.equal(record.error_code, fixture.error);
    assert.equal(record.finish_reason, fixture.finish);
    assert.equal(record.response_status, fixture.data.status ?? null);
    assert.deepEqual(record.content_types, fixture.types);
    assert.equal(record.prompt_tokens, 600);
    assert.equal(record.completion_tokens, 4096);
    assert.equal(record.total_tokens, 4696);
    assert.equal(record.reasoning_tokens, fixture.reasoning);
    assert.equal(record.truncated, fixture.truncated);
    for (const field of ["finish_reason", "response_status", "content_types", "prompt_tokens", "completion_tokens", "reasoning_tokens", "truncated"]) {
      assert.deepEqual(result.diagnostics[field], record[field]);
    }
    if (fixture.error) assert.equal(result.result, undefined);
    else assert.equal(result.result.text, "PRIVATE_PARTIAL_ANSWER");
    const disk = readdirSync(directory).map(file => readFileSync(join(directory, file), "utf8")).join("");
    assert.ok(!disk.includes("PRIVATE_"));
    assert.ok(!disk.includes("synthetic-secret"));
  });
});

test("omitted and explicit large budgets survive dispatch, replay input and persisted metadata", async () => {
  for (const max_tokens of [undefined, 65536]) {
    const store = new MonitorStore(temp());
    const bridge = new Bridge({
      monitor: store,
      resolveProvider: async () => ({ key: "synthetic-key", protocol: "openai-responses", base_url: "https://example.invalid/v1", model: "test-model" }),
      fetchImpl: async (_, options) => {
        const body = JSON.parse(options.body);
        assert.equal(Object.hasOwn(body, "max_output_tokens"), max_tokens !== undefined);
        assert.equal(body.max_output_tokens, max_tokens);
        return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
      }
    });
    const { job_id } = await bridge.submit({ task: "Review", max_tokens });
    await bridge.jobs.get(job_id).done;
    assert.equal(bridge.result(job_id).status, "completed");
    assert.equal(bridge.jobs.get(job_id).retry_input.max_tokens, max_tokens);
    assert.equal(store.readAll()[0].max_tokens, max_tokens ?? null);
  }
});

test("real bridge filters outgoing text and returned answer; storage contains metadata only", async () => {
  const directory = temp();
  const store = new MonitorStore(directory);
  let sent = "";
  const bridge = new Bridge({
    monitor: store, getKey: async () => "exact-secret-key",
    fetchImpl: async (_, options) => {
      sent = options.body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "PRIVATE_RESPONSE person@example.com exact-secret-key" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      }));
    }
  });
  const job = await bridge.submit({
    task: "PRIVATE_TASK api_key=exact-secret-key",
    context: "person@example.com 13812345678",
    history: [{ role: "user", content: "password=secret-value" }],
    parent_id: randomUUID()
  });
  await bridge.jobs.get(job.job_id).done;
  assert.ok(!sent.includes("exact-secret-key"));
  assert.ok(!sent.includes("person@example.com"));
  assert.ok(!sent.includes("secret-value"));
  const answer = bridge.result(job.job_id).result.text;
  assert.ok(!answer.includes("person@example.com"));
  assert.ok(!answer.includes("exact-secret-key"));
  const disk = readdirSync(directory).map(name => readFileSync(join(directory, name), "utf8")).join("");
  for (const value of ["PRIVATE_TASK", "PRIVATE_RESPONSE", "person@example.com", "exact-secret-key", "secret-value"]) assert.ok(!disk.includes(value));
  assert.equal(store.readAll()[0].status, "completed");
  assert.equal(store.readAll()[0].total_tokens, 30);
  assert.ok(store.readAll()[0].redactions >= 5);
});

test("no paid request is sent if initial audit metadata cannot be written", async () => {
  const bridge = new Bridge({
    getKey: async () => "fixture-key",
    monitor: { write() { throw new Error("Disk full"); } },
    fetchImpl: () => assert.fail("must not call API")
  });
  await assert.rejects(bridge.submit({ task: "Task" }), /No API request was sent/);
});

test("failed provider response becomes a fixed classification without raw error body", async () => {
  const store = new MonitorStore(temp());
  const bridge = new Bridge({
    monitor: store, getKey: async () => "fixture-key",
    fetchImpl: async () => new Response("PRIVATE_ERROR_BODY", { status: 401 })
  });
  const { job_id } = await bridge.submit({ task: "Task" });
  await bridge.jobs.get(job_id).done;
  assert.equal(store.readAll()[0].error_code, "AUTH");
  assert.equal(store.readAll()[0].status, "failed");
  assert.ok(!JSON.stringify(store.readAll()).includes("PRIVATE_ERROR_BODY"));
});

test("heartbeat expiry, corrupt records, and retention are handled without inventing completion", () => {
  const directory = temp();
  const store = new MonitorStore(directory);
  const stale = { ...base(), updated_at: new Date(Date.now() - 25000).toISOString() };
  store.write(stale);
  store.write({ ...base(), created_at: new Date(Date.now() - 8 * 86400000).toISOString() });
  writeFileSync(join(directory, `${randomUUID()}.json`), '{"secret":"PRIVATE","broken":');
  assert.equal(store.readAll().length, 1);
  assert.equal(store.readAll()[0].status, "interrupted");
  store.prune();
  assert.equal(readdirSync(directory).length, 2);
});

test("HTTP is read-only, same-origin, and exports only whitelisted data", async () => {
  const directory = temp();
  const store = new MonitorStore(directory);
  const record = base();
  writeFileSync(join(directory, `${record.id}.json`), JSON.stringify({ ...record, task: "PRIVATE_TASK" }));
  const server = createMonitorServer(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    const good = await requestWithHeaders(port, "/api/export", {});
    assert.equal(good.status, 200);
    assert.ok(!good.text.includes("PRIVATE_TASK"));
    assert.match(good.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(good.headers["access-control-allow-origin"], undefined);
    assert.equal((await requestWithHeaders(port, "/api/jobs", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await requestWithHeaders(port, "/api/jobs", { Host: `evil.example:${port}` })).status, 403);
    assert.equal((await requestWithHeaders(port, "/api/jobs", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await requestWithHeaders(port, "/api/jobs", {}, "POST")).status, 405);
    assert.equal((await requestWithHeaders(port, "/credentials.mjs", {})).status, 404);
    assert.equal((await requestWithHeaders(port, "/.monitor/secret.json", {})).status, 404);
    assert.equal((await requestWithHeaders(port, "/%2e%2e/read-key.ps1", {})).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("encrypted Windows key with trailing newline remains readable", { skip: process.platform !== "win32" }, async () => {
  const directory = temp();
  const exec = promisify(execFile);
  const encrypted = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "ConvertFrom-SecureString (ConvertTo-SecureString 'synthetic-fixture-key' -AsPlainText -Force)"
  ], { windowsHide: true });
  mkdirSync(join(directory, "CodexDeepSeek"));
  writeFileSync(join(directory, "CodexDeepSeek", "api-key.dpapi"), `${encrypted.stdout.trim()}\r\n`);
  const actual = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fileURLToPath(new URL("./read-key.ps1", import.meta.url))
  ], { env: { ...process.env, LOCALAPPDATA: directory }, windowsHide: true });
  assert.equal(actual.stdout, "synthetic-fixture-key");
});
