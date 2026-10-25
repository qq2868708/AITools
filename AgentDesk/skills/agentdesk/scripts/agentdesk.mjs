import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const ACTIONS = new Set(["status", "records", "provider_list", "task_submit", "task_result", "task_trace", "task_retry", "task_cancel"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = {
  records: ["limit", "provider_id", "trace_id"],
  task_submit: ["provider_id", "key_id", "task", "context", "role", "parent_id", "model", "max_tokens", "history"],
  task_result: ["job_id"],
  task_trace: ["job_id", "include_body"],
  task_retry: ["job_id", "key_id"],
  task_cancel: ["job_id"]
};

class InputError extends Error {}

function options() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) return { help: true };
  const action = args.shift();
  if (!ACTIONS.has(action)) throw new InputError("Unknown action. Run --help for supported actions.");
  let home = process.env.AGENTDESK_HOME || "E:\\AITools\\AgentDesk";
  while (args.length) {
    if (args.shift() !== "--home" || !args.length) throw new InputError("Only --home <installation-directory> is supported.");
    home = args.shift();
  }
  return { action, home: resolve(home) };
}

async function readInput(action) {
  if (["status", "provider_list"].includes(action) || process.stdin.isTTY) return {};
  process.stdin.setEncoding("utf8");
  let text = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1000000) throw new InputError("JSON input exceeds 1 MB.");
    text += chunk;
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch { throw new InputError("Expected a JSON object on stdin. Input contents were not logged."); }
}

function validate(action, input) {
  const allowed = FIELDS[action] ?? [];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new InputError("Unexpected input field. Never pass API keys or authorization headers.");
  for (const field of ["provider_id", "key_id", "parent_id", "job_id", "trace_id"]) {
    if (input[field] != null && (typeof input[field] !== "string" || !UUID.test(input[field]))) {
      throw new InputError("Identifier fields must contain UUIDs returned by Agent Desk.");
    }
  }
  if (["task_result", "task_trace", "task_retry", "task_cancel"].includes(action) && !input.job_id) {
    throw new InputError("job_id is required.");
  }
  if (action === "task_submit") {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 100000) throw new InputError("task must contain 1 to 100000 characters.");
    if (input.context != null && (typeof input.context !== "string" || input.context.length > 200000)) throw new InputError("context must contain at most 200000 characters.");
    if (input.role != null && !["analyst", "reviewer", "planner"].includes(input.role)) throw new InputError("Unknown task role.");
    if (input.model != null && (typeof input.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(input.model))) throw new InputError("Invalid model ID.");
    if (input.max_tokens != null && (!Number.isInteger(input.max_tokens) || input.max_tokens < 256 || input.max_tokens > 16384)) throw new InputError("max_tokens must be between 256 and 16384.");
    if (input.history != null && (!Array.isArray(input.history) || input.history.length > 20 || input.history.some(message =>
      !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" ||
      message.content.length > 50000 || Object.keys(message).some(key => !["role", "content"].includes(key))
    ))) throw new InputError("history accepts up to 20 user/assistant messages.");
    if (input.task.length + (input.context?.length ?? 0) + JSON.stringify(input.history ?? []).length > 300000) throw new InputError("Combined task/context/history exceeds 300000 characters.");
  }
  if (input.include_body != null && typeof input.include_body !== "boolean") throw new InputError("include_body must be a boolean.");
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new InputError("limit must be between 1 and 100.");
}

function safeError(error) {
  if (error instanceof InputError) return { error: "INVALID_INPUT", message: error.message };
  if (["ERR_MODULE_NOT_FOUND", "ENOENT"].includes(error.code)) {
    return { error: "INSTALLATION_NOT_FOUND", message: "Check the Agent Desk installation path or supply --home." };
  }
  const known = [
    "Restart the local platform service to enable request records and recovery.",
    "API platform is unavailable. Run start-monitor.cmd and try again.",
    "Invalid session token. Reload the page.",
    "No enabled, available API key for this provider.",
    "Provider is disabled.",
    "Provider not found.",
    "Selected key is unavailable or belongs to another provider.",
    "Two jobs are already running. Wait for a result before submitting another.",
    "Request record not found or expired.",
    "This request cannot be retried. Use the latest failed attempt with an available complete request body.",
    "Provider endpoint changed. Review the destination and submit a new task."
  ];
  return {
    error: "PLATFORM_REQUEST_FAILED",
    message: known.includes(error.message) ? error.message : "Inspect the local platform for details. If a submission may have been sent, check existing records before any retry."
  };
}

try {
  const { action, home, help } = options();
  if (help) {
    console.log("Usage: node agentdesk.mjs <action> [--home <installation-directory>]\nActions: status, records, provider_list, task_submit, task_result, task_trace, task_retry, task_cancel\nPass action arguments as a JSON object on stdin. This helper does not retry calls.");
  } else {
    const input = await readInput(action);
    validate(action, input);
    const client = await import(pathToFileURL(join(home, "platform-client.mjs")).href);
    let result;
    if (action === "status" || action === "records") {
      const { port } = await client.ensurePlatform();
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new InputError("Invalid local platform port.");
      const origin = `http://127.0.0.1:${port}`;
      const response = await fetch(`${origin}${action === "status" ? "/health" : "/api/jobs"}`, {
        signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store"
      });
      if (!response.ok) throw new Error("Local query failed.");
      const data = await response.json();
      if (action === "status") {
        result = { url: origin, service: data.service, version: data.version, ok: data.ok === true, request_logs: data.request_logs === true };
      } else {
        const matched = data.jobs.filter(job =>
          (!input.provider_id || job.provider_id === input.provider_id) && (!input.trace_id || job.trace_id === input.trace_id));
        result = { generated_at: data.generated_at, privacy: "metadata-only", total: matched.length, jobs: matched.slice(0, input.limit ?? 20) };
      }
    } else {
      result = await client.platformRpc(action, input);
    }
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
}
