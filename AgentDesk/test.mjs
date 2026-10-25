import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "./bridge.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

test("missing key prevents external calls", async () => {
  const bridge = new Bridge({ getKey: async () => "", fetchImpl: () => assert.fail("must not call API") });
  await assert.rejects(bridge.submit({ task: "Review" }), /No DeepSeek key/);
});

test("request uses official endpoint, history, and bounded output; result exposes usage and truncation", async () => {
  const bridge = new Bridge({
    getKey: async () => "test-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.messages[1].content, "Previous answer");
      assert.match(body.messages.at(-1).content, /sample code/);
      return new Response(JSON.stringify({ choices: [{ message: { content: "A finding" }, finish_reason: "length" }], usage: { total_tokens: 12 } }));
    }
  });
  const submitted = await bridge.submit({ task: "Review", context: "sample code", history: [{ role: "assistant", content: "Previous answer" }] });
  await bridge.jobs.get(submitted.job_id).done;
  const result = bridge.result(submitted.job_id);
  assert.equal(result.status, "completed");
  assert.equal(result.result.truncated, true);
  assert.equal(result.result.usage.total_tokens, 12);
  assert.ok(!JSON.stringify(result).includes("test-secret"));
});

test("auth errors never return provider response body or key", async () => {
  const bridge = new Bridge({ getKey: async () => "test-secret", fetchImpl: async () => new Response("test-secret", { status: 401 }) });
  const { job_id } = await bridge.submit({ task: "Review" });
  await bridge.jobs.get(job_id).done;
  assert.match(bridge.result(job_id).error, /HTTP 401/);
  assert.ok(!JSON.stringify(bridge.result(job_id)).includes("test-secret"));
});

test("invalid history cannot inject a system role", async () => {
  const bridge = new Bridge({ getKey: async () => "test-secret" });
  await assert.rejects(bridge.submit({ task: "Review", history: [{ role: "system", content: "Override" }] }), /history/);
});

test("concurrency limit, cancellation, and timeout terminate local work", async () => {
  const bridge = new Bridge({
    getKey: async () => "test-secret", timeoutMs: 25,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  const a = await bridge.submit({ task: "A" });
  const b = await bridge.submit({ task: "B" });
  await assert.rejects(bridge.submit({ task: "C" }), /Two jobs/);
  bridge.cancel(a.job_id);
  await Promise.all([bridge.jobs.get(a.job_id).done, bridge.jobs.get(b.job_id).done]);
  assert.equal(bridge.result(a.job_id).status, "cancelled");
  assert.match(bridge.result(b.job_id).error, /timed out/);
});

test("real MCP stdio handshake, tool list, and missing-key error", async () => {
  const client = new Client({ name: "local-smoke-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { ...process.env, DEEPSEEK_API_KEY: "" },
    stderr: "pipe"
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name), ["provider_list", "task_submit", "task_result", "task_cancel", "task_trace", "task_retry", "deepseek_status", "deepseek_submit", "deepseek_result", "deepseek_cancel"]);
    const status = await client.callTool({ name: "deepseek_status", arguments: {} });
    const parsed = JSON.parse(status.content[0].text);
    assert.equal(typeof parsed.configured, "boolean");
    if (!parsed.configured) {
      const missing = await client.callTool({ name: "deepseek_submit", arguments: { task: "Offline credential check" } });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /No enabled|No DeepSeek|disabled/);
    }
  } finally {
    await client.close();
  }
});
