# Agent Desk: Local API Platform

Use the `AgentDesk` directory in this checkout.
Double-click `start-monitor.cmd` here to open the platform.
Private state (`.platform/`, `.monitor/`), dependencies, test output (`work/`),
environment files, and logs are excluded from Git by the local `.gitignore`.
Do not force-add these directories or files to source control.

Manage multiple AI providers, multiple API keys per provider, model configuration,
subtask dispatch, and redacted execution monitoring.
An MCP registration, if configured, connects to this shared platform through `server.mjs`.
Providers remain advisory workers without file or command execution tools.

## Activate

1. Double-click `start-monitor.cmd`. The default address is `http://127.0.0.1:4318`.
2. Add a provider with its base URL, protocol, model IDs, and default model.
3. Add one or more named API keys. Test each key through the models endpoint.
4. Choose a default provider and either round-robin or first-available key selection.
5. Dispatch through the page or Codex's MCP tools.

The initial platform setup imports the existing DeepSeek credential once, without
showing it or deleting the legacy encrypted credential. Subsequent key changes
belong in this platform; `setup-key.cmd` only changes the legacy credential file.
No Codex restart is needed for provider/key configuration changes.
Restart/reload Codex once after upgrading the MCP code to expose the new tools.

Provider configuration lives in `.platform/providers.json`. Every key is encrypted
with Windows DPAPI for the current account. The management API returns key IDs,
labels, and a fixed mask, never plaintext or encrypted credential blobs.
Other programs running as the same Windows user can decrypt these credentials.
Do not move this folder or share its `.platform/` directory.

Supported protocols:

| Protocol | Base URL example | Completion endpoint |
| --- | --- | --- |
| OpenAI Chat Completions | `https://api.deepseek.com` | `/chat/completions` |
| OpenAI Responses | `https://api.openai.com/v1` | `/responses` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` |

Custom compatible providers can use any of these protocols. HTTPS is required,
except for explicit loopback HTTP providers. URLs with credentials, query strings,
or fragments are rejected, and upstream redirects are not followed.
Only DeepSeek official chat requests add the `thinking: disabled` parameter.
Model IDs are configured by the user; preset pages do not guess OpenAI/Anthropic models.
Not every vendor implements the complete compatible API or models endpoint.

## Tools

A reusable Codex skill is included at `skills/agentdesk/SKILL.md`. Install its folder
in the current user's skills directory (for example `~/.agents/skills/agentdesk`),
and add `local-installation.json` with `{"home":"<absolute AgentDesk directory>"}`.
The repository helper resolves this checkout directly; `--home` or `AGENTDESK_HOME`
can override the location. Invoke `$agentdesk` to route
authorized work through the platform. The skill prefers MCP and includes a
local CLI fallback; it does not store keys or authorize automatic paid retries.

- `provider_list`: provider/model configuration and safe key IDs/health.
- `task_submit`: submit a task with optional `provider_id`, `key_id`, `model`, and `parent_id`.
- `task_result`: retrieve the status and redacted reply.
- `task_cancel`: stop local waiting; provider processing or charges may continue.
- `task_trace`: request/response lifecycle, HTTP status, retry chain, and recovery availability.
  Set `include_body: true` only when recorded body content is needed.
- `task_retry`: explicitly retry the latest failed, interrupted, or cancelled attempt.
  This creates a new paid request; use only after the user requests recovery.
- `deepseek_status`, `deepseek_submit`, `deepseek_result`, and `deepseek_cancel`:
  backwards-compatible aliases; `deepseek_submit` routes to the configured official DeepSeek provider.

Provider/key selection is serialized through one local service shared by MCP clients
and the browser. An explicit key must belong to the selected provider and be enabled.
Automatic routing skips disabled keys, authentication failures, and rate-limit cooldowns
(60 seconds). Explicit key selection can retry a previously failed key.
No failed paid request is automatically retried against another key.
Key replacement or endpoint changes reset relevant validation state.
Deleting providers/keys used by running tasks is blocked until those tasks finish or are cancelled.

Tasks support explicit user/assistant history and a 180-second local timeout.
Output budgets are optional with no default and no local 16384-token ceiling.
OpenAI-compatible requests omit the output-limit parameter unless `max_tokens`
is explicitly supplied; upstream model limits still apply. Native Anthropic
Messages requires an explicit `max_tokens` value and rejects omission locally.
Results and trace metadata preserve token usage, reported reasoning usage,
response status, finish reason, and allowlisted content types even when no answer
text is returned. An explicit output-limit finish reason with no answer is
`OUTPUT_LIMIT`; other answerless responses remain `EMPTY_RESPONSE`. This does
not trigger an automatic retry. Diagnostic metadata contains no response text.
There are at most two concurrent tasks across the platform, and the latest 30 task results
remain in memory. Closing an MCP client does not stop its tasks. Restarting the
platform loses in-memory results; safe historical metadata survives.

## Request And Recovery Records

On the task page, open a task to view Overview, Request / Response, and Recovery Chain.
The overview includes HTTP status, a trace ID, attempt number, and lifecycle events.
Retries have new job IDs, keep the original failure, and share a trace ID.

Body recording is **off by default**. Enable it through Request Record Settings to
record subsequent requests and replies. The setting is not retroactive.
Bodies are rule-redacted, encrypted with Windows DPAPI, and stored under
`.platform/request-bodies/`. Each request input and response is limited to 64,000
characters. The request is a normalized task/context/history snapshot, not raw
HTTP headers; credentials are never included.
Only authenticated detail requests can decrypt these records.
Bulk export continues to contain metadata only. Exporting an individual recorded
request explicitly includes its redacted body, rechecked against current saved keys.
Turning off recording does not erase prior records; normal retention still applies.

Service startup records abandoned requests as interrupted and never replays them
automatically. Explicit recovery requires either a complete request still held in
memory or a complete encrypted request record. A truncated record cannot recover
a task after memory is lost. Changing the provider endpoint blocks replay until a
new task is explicitly submitted for that destination.

The UI confirms that a retry can be billed again and that an earlier remote request
may still be running. Concurrent retry clicks are serialized, completed chains cannot
be retried, and only the latest unsuccessful attempt is recoverable (up to ten attempts).
Existing provider key-selection policies apply; a specific enabled key may be selected.
If initial request recording fails, no provider call is sent. If response recording
fails after a successful provider call, the successful result remains valid and the
recording failure is flagged separately.

## Monitoring And Privacy

The task page displays provider/key attribution, status, elapsed time, token usage,
character counts, redaction counts, and fixed error categories. It supports filtering,
ID search, sorting, details, cancellation, refresh, and JSON export.
Only tasks sent through this platform are monitored. Native Codex subagents and
requests made outside it are not observed. Older records without provider/key IDs
remain visible but are not assigned to a key retroactively.

Privacy controls:

- A whitelist determines every field written into `.monitor/` and served over HTTP.
- Prompts, responses, raw provider errors, and keys are never written to metadata records.
  Optional request/response bodies are kept separately, redacted and encrypted.
- All saved API keys, common credential patterns, emails, phone numbers, URLs,
  IP addresses, and common absolute paths are replaced in outgoing input and incoming replies.
  Pattern matching cannot recognize every sensitive fact. Names, business secrets, and
  unusual formats still require review before delegation. Filtering can alter code examples.
- Metadata is retained for seven days, up to 500 records, with cleanup every minute
  while the server is running. Encrypted bodies are pruned with their metadata.
  Browser/API reads are capped at 500 records.
- A missed 20-second heartbeat displays `interrupted`; remote processing may continue.
- The HTTP service binds only to IPv4 loopback, checks Host and Origin, rejects cross-site
  requests, has no CORS permissions, uses a restrictive CSP, and exposes only allowlisted routes.
  All mutations and task-result retrieval require a local session token.
  This is not isolation from other programs running as your Windows user.
- Provider/key labels and model names are public configuration metadata; do not put secrets in them.

Token counts include only usage returned by the API. Failed or cancelled requests may
still incur charges that the monitor cannot measure. No currency costs are estimated.
No background scheduled automation or automatic API retries are installed.

## Maintenance

Run `npm.cmd test` in this directory for tests. The MCP handshake test may start the local
platform and import the existing key once; it does not call paid provider completions.
Run `codex mcp remove deepseek` to unregister this bridge.
Keep this folder in place while it is registered.
Run `npm.cmd run monitor` to start the platform manually. `MONITOR_PORT` can select another port.
The launcher reuses a running platform or selects another available port.
No scheduled automation, automatic retries, or autostart-at-login is installed.
