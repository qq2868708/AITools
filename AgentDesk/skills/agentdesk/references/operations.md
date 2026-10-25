# Agent Desk Operations

## Tool Selection

| Intent | Tool/action | Key arguments |
| --- | --- | --- |
| Configured providers, models, masked key IDs | `provider_list` | None |
| New delegated task | `task_submit` | `task`, optional `provider_id`, `key_id`, `model`, `role`, `context`, `history`, `parent_id`, `max_tokens` |
| Completion/result | `task_result` | `job_id` |
| Timeline, HTTP status, recovery chain | `task_trace` | `job_id`, `include_body` (default false) |
| Explicitly requested retry | `task_retry` | `job_id`, optional `key_id` |
| Requested cancellation | `task_cancel` | `job_id` |

Roles are `analyst`, `reviewer`, and `planner`.
The default output allowance is 4096 tokens; valid explicit values are 256–16384.
Task text is limited to 100,000 characters, context to 200,000, and combined
task/context/history to 300,000. History accepts at most 20 user/assistant messages.
These limits are ceilings, not target prompt sizes.

The MCP server name `deepseek` is historical. Generic `task_*` tools can route to
any configured provider. `deepseek_submit` specifically selects official DeepSeek.
A configured name such as Gemini does not imply a native Gemini adapter;
use the protocol, base URL, and model IDs already configured in Agent Desk.

## Local Helper

The helper uses the installed `platform-client.mjs`; it never reads a provider
credential directly. That client may start the local service if it is not running.
It never starts a paid provider request merely to check status.

Examples below use the copy shipped with the tool. The globally installed skill's
`scripts/agentdesk.mjs` is equivalent.

```powershell
node 'E:\AITools\AgentDesk\skills\agentdesk\scripts\agentdesk.mjs' status
node 'E:\AITools\AgentDesk\skills\agentdesk\scripts\agentdesk.mjs' provider_list
'{}' | node 'E:\AITools\AgentDesk\skills\agentdesk\scripts\agentdesk.mjs' records
```

`status` returns only service version, loopback address, and feature flags.
`records` returns the latest 20 metadata records by default; JSON input can select
`limit` (1–100) and optionally filter by `provider_id` or `trace_id`.

For actions with arguments, pass a JSON object on stdin. A single-quoted
PowerShell here-string preserves task text without shell interpolation.
Replace example IDs with actual UUIDs from provider metadata or prior results.

```powershell
@'
{
  "provider_id": "<provider UUID>",
  "role": "reviewer",
  "task": "Review the supplied change for concrete correctness problems.",
  "context": "<minimal relevant code and requirements>",
  "max_tokens": 2048
}
'@ | node 'E:\AITools\AgentDesk\skills\agentdesk\scripts\agentdesk.mjs' task_submit
```

```powershell
@'
{"job_id":"<actual job UUID>","include_body":false}
'@ | node 'E:\AITools\AgentDesk\skills\agentdesk\scripts\agentdesk.mjs' task_trace
```

Use the corresponding action name with `{"job_id":"<actual job UUID>"}` for
`task_result`, `task_cancel`, or an authorized `task_retry`.
Do not repeatedly resubmit when waiting for a result.

The helper prints JSON and uses a nonzero exit status on failure.
Unknown commands/fields, malformed JSON, invalid UUIDs, and oversized input
are rejected before contacting the platform. It does not retry operations.
Unexpected exception details are suppressed to avoid exposing request contents
or session credentials; inspect the local platform for further diagnosis.

## Provider And Key Configuration

Launch `E:\AITools\AgentDesk\start-monitor.cmd` to open the current service.
The port is discovered from the local runtime; do not assume 4318 if another
port was selected. Use `#providers` for configuration and `#tasks` for monitoring.

The provider controls support base URL, protocol, model IDs, default model,
enabled state, default provider, and key policy. A provider can have multiple
named keys with separate validation and enabled states.
Use the user's existing destination and model choices; do not guess a compatible
protocol or insert a guessed `/v1` path just from a display name.

Supported protocols:

| Protocol | Completion route appended to Base URL |
| --- | --- |
| `openai-chat` | `/chat/completions` |
| `openai-responses` | `/responses` |
| `anthropic` | `/messages` |

Base URL excludes the completion route, query strings, and embedded credentials.
Key validation queries `/models`, which some compatible gateways do not implement;
failure of that check alone does not prove that completion requests are unsupported.

Keep key entry/replacement in the local platform workflow. Use UUIDs for selecting
saved credentials. Round-robin and priority policies select enabled, eligible keys;
automatic routing skips authentication failures and rate-limit cooldowns.
An explicit key must belong to the selected provider.

If the platform says configuration labels/addresses contain an API key, describe
the guard without revealing the value. A URL/model may have been mistakenly entered
as a key. Have the incorrect credential corrected locally; do not weaken the guard
or expose/decrypt the stored key to diagnose an ordinary configuration request.

Provider/key mutations, deletion, and enabling body recording are not part of
routine inspection. Honor a specific user request and applicable authorization;
do not invent additional approval requirements for already-authorized work.

## Failure And Recovery

`task_result` results live in the service process, bounded to the latest 30 jobs.
After a restart or eviction, inspect `task_trace` or metadata `records`; do not assume
an unavailable result means no request was sent.

Trace metadata is retained for seven days, up to 500 records. Body recording is
off by default. When enabled beforehand, normalized input and reply text are
redacted and Windows-encrypted, each capped at 64,000 characters.
Truncated stored input cannot be replayed after process memory is lost.

Use these states to decide the next action:

- `running`: poll, or perform other authorized local work.
- `completed`: inspect/verify the answer; do not retry a completed chain.
- `failed`: inspect HTTP status, fixed error category, and recovery eligibility.
- `cancelled` / `interrupted`: remote execution/billing may still have happened.
  Inspect the trace before any user-authorized retry.

Retries create a new ID with the same trace ID and increased attempt number.
Only the latest eligible unsuccessful attempt can be retried; the platform
prevents concurrent retries and caps a chain at ten attempts.
Do not bypass these protections with `task_submit`.

If the helper reports the service must be upgraded/restarted, preserve active work
and use the user's existing authorization for the lifecycle action. Do not kill
unrelated Node processes, reset configuration, or work around a tool-policy denial.
