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
    total_tokens: "SECRET_USAGE", error_code: "SECRET_ERROR_CODE"
  });
  assert.ok(!JSON.stringify(safe).includes("SECRET"));
  assert.equal(safe.total_tokens, null);
  assert.equal(safe.model, "custom-model");
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
