import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { platformRpc } from "./platform-client.mjs";

const server = new Server({ name: "agent-api-platform", version: "3.0.0" }, { capabilities: { tools: {} } });
const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const jobSchema = { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false };
const taskSchema = {
  type: "object",
  properties: {
    provider_id: { type: "string", format: "uuid", description: "Provider ID from provider_list; otherwise uses the configured default." },
    key_id: { type: "string", format: "uuid", description: "Optional explicit key ID; otherwise uses the provider key selection policy." },
    task: { type: "string", minLength: 1, maxLength: 100000 },
    context: { type: "string", maxLength: 200000 },
    role: { type: "string", enum: ["analyst", "reviewer", "planner"] },
    parent_id: { type: "string", format: "uuid" },
    model: { type: "string", description: "Model ID; defaults to the selected provider model." },
    max_tokens: { type: "integer", minimum: 256, maximum: 16384, default: 4096 },
    history: {
      type: "array", maxItems: 20, items: {
        type: "object", properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string", maxLength: 50000 } },
        required: ["role", "content"], additionalProperties: false
      }
    }
  }, required: ["task"], additionalProperties: false
};
const readAnnotations = { readOnlyHint: true, openWorldHint: false };
const submitAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "provider_list", description: "List configured providers, protocols, models, safe key IDs and health. Never returns API credentials. Use IDs to route subtasks.", inputSchema: emptySchema, annotations: readAnnotations },
    { name: "task_submit", description: "Dispatch analysis/review/planning to a configured AI provider and optional key. Consumes provider balance. Common sensitive patterns and saved keys are filtered; still minimize context. Provider/key attribution appears in the local monitor. No file or shell access; verify untrusted returned advice. Returns a job ID immediately. Tasks are shared across MCP sessions through the local platform.", inputSchema: taskSchema, annotations: submitAnnotations },
    { name: "task_result", description: "Retrieve task status and the redacted result held in process memory. Optional encrypted request records are separately available via task_trace after a restart. Allow several seconds between polls.", inputSchema: jobSchema, annotations: readAnnotations },
    { name: "task_cancel", description: "Cancel local waiting. Remote processing or billing may continue.", inputSchema: jobSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: "task_trace", description: "Inspect request/response lifecycle, HTTP status, retry chain and recovery availability. include_body returns redacted, encrypted-at-rest request/response text only when the user enabled body recording before this request. Do not include sensitive body text unnecessarily.", inputSchema: {
      type: "object", properties: { job_id: { type: "string" }, include_body: { type: "boolean", default: false } }, required: ["job_id"], additionalProperties: false
    }, annotations: readAnnotations },
    { name: "task_retry", description: "Manually retry the latest failed/cancelled/interrupted attempt using an available complete redacted request. Creates a new paid provider request, preserves previous history and links trace IDs. Only call after explicit user intent to retry or recover this task. Never automatically retry uncertain outcomes; the previous provider request may still run or incur charges.", inputSchema: {
      type: "object", properties: { job_id: { type: "string" }, key_id: { type: "string", format: "uuid" } }, required: ["job_id"], additionalProperties: false
    }, annotations: submitAnnotations },
    { name: "deepseek_status", description: "Compatibility alias: check DeepSeek configuration and platform status. No paid request.", inputSchema: emptySchema, annotations: readAnnotations },
    { name: "deepseek_submit", description: "Compatibility alias: submit through the configured official DeepSeek provider. Prefer task_submit for multi-provider routing.", inputSchema: taskSchema, annotations: submitAnnotations },
    { name: "deepseek_result", description: "Compatibility alias for task_result.", inputSchema: jobSchema, annotations: readAnnotations },
    { name: "deepseek_cancel", description: "Compatibility alias for task_cancel.", inputSchema: jobSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const result = await platformRpc(params.name, params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
