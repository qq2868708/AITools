import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MonitorStore } from "./monitor-store.mjs";
import { Platform } from "./platform.mjs";
import { redact } from "./redact.mjs";
import { join } from "node:path";
import { PLATFORM_DIR } from "./providers.mjs";
import { acquireServiceLock } from "./service-lock.mjs";

const files = {
  "/": ["./public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["./public/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["./public/style.css", "text/css; charset=utf-8"],
  "/platform-ui.js": ["./public/platform-ui.js", "text/javascript; charset=utf-8"],
  "/platform.css": ["./public/platform.css", "text/css; charset=utf-8"],
  "/icons.js": ["./node_modules/lucide/dist/umd/lucide.js", "text/javascript; charset=utf-8"]
};

async function readJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("JSON body required.");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1000000) throw new Error("Request body too large.");
  }
  try {
    const parsed = JSON.parse(body || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch { throw new Error("Invalid JSON body."); }
}

export function createMonitorServer(store = new MonitorStore(), platform = null) {
  return createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    const expectedOrigin = `http://${expectedHost}`;
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    };
    const send = (status, body, type = "application/json; charset=utf-8", extra = {}) => {
      response.writeHead(status, { ...headers, "Content-Type": type, ...extra });
      response.end(body);
    };
    if (request.headers.host !== expectedHost ||
        (request.headers.origin && request.headers.origin !== expectedOrigin) ||
        request.headers["sec-fetch-site"] === "cross-site") {
      return send(403, '{"error":"Local same-origin access only."}');
    }
    if (request.method !== "GET" && !platform) return send(405, '{"error":"Read-only monitor."}', undefined, { Allow: "GET" });
    const path = new URL(request.url, expectedOrigin).pathname;
    try {
      if (platform) {
        if (request.method === "GET" && path === "/api/session") return send(200, JSON.stringify({ token: platform.token }));
        if (request.method === "GET" && path === "/api/providers") return send(200, JSON.stringify(platform.registry.publicData()));
        if (request.method === "GET" && path === "/api/logging") return send(200, JSON.stringify(platform.requestLogs.publicSettings()));
        if (request.method !== "GET") {
          if (!platform.authorized(request.headers["x-platform-token"])) return send(403, '{"error":"Invalid session token. Reload the page."}');
          const body = await readJson(request);
          let result;
          const match = path.match(/^\/api\/providers\/([0-9a-f-]{36})(?:\/keys\/([0-9a-f-]{36}))?(?:\/(keys|test|default))?$/);
          if (path === "/api/rpc" && request.method === "POST") result = await platform.rpc(body.action, body.args);
          else if (path === "/api/logging" && request.method === "PATCH") result = platform.requestLogs.updateSettings(body);
          else if (path === "/api/providers" && request.method === "POST") result = await platform.registry.create(body);
          else if (match) {
            const [, providerId, keyId, operation] = match;
            if (operation === "test" && keyId && request.method === "POST") result = await platform.registry.testKey(providerId, keyId);
            else if (operation === "default" && !keyId && request.method === "POST") result = await platform.registry.setDefault(providerId);
            else if (operation === "keys" && !keyId && request.method === "POST") result = await platform.registry.addKey(providerId, body);
            else if (!operation && request.method === "PATCH") result = keyId
              ? await platform.registry.updateKey(providerId, keyId, body) : await platform.registry.update(providerId, body);
            else if (!operation && request.method === "DELETE") {
              platform.requireIdle(providerId, keyId);
              result = keyId ? await platform.registry.removeKey(providerId, keyId) : await platform.registry.remove(providerId);
            } else return send(404, '{"error":"Unknown operation."}');
          } else return send(404, '{"error":"Unknown route."}');
          return send(200, JSON.stringify(result));
        }
      }
      if (path === "/api/jobs" || path === "/api/export") {
        const data = JSON.stringify({
          generated_at: new Date().toISOString(),
          retention_days: 7,
          max_records: 500,
          privacy: "metadata-only",
          jobs: store.readAll()
        });
        return send(200, data, undefined, path.endsWith("export") ? {
          "Content-Disposition": 'attachment; filename="subtask-monitor.json"'
        } : {});
      }
      if (path === "/health") return send(200, JSON.stringify({ service: platform ? "agent-api-platform" : "deepseek-task-monitor", version: platform ? 3 : 1, ok: true, request_logs: Boolean(platform) }));
      if (!Object.hasOwn(files, path)) return send(404, '{"error":"Not found."}');
      const [file, type] = files[path];
      return send(200, readFileSync(new URL(file, import.meta.url)), type);
    } catch (error) {
      const message = platform && request.method !== "GET"
        ? redact(String(error.message)).text.slice(0, 250) : "Monitoring data temporarily unavailable.";
      return send(platform && request.method !== "GET" ? 400 : 503, JSON.stringify({ error: message }));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseLock = acquireServiceLock(PLATFORM_DIR);
  process.once("exit", releaseLock);
  const port = Number(process.env.MONITOR_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid monitor port.");
  const store = new MonitorStore();
  const platform = new Platform({ store });
  await platform.initialize();
  const cleanup = setInterval(() => platform.prune(), 60000);
  cleanup.unref();
  const server = createMonitorServer(store, platform);
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? "Monitor port is busy. Set MONITOR_PORT to another port." : "Monitor failed to start.");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const runtime = join(platform.registry.directory, "runtime.json");
    writeFileSync(`${runtime}.tmp`, JSON.stringify({ port, token: platform.token, pid: process.pid }), { mode: 0o600 });
    renameSync(`${runtime}.tmp`, runtime);
    console.log(`API platform: http://127.0.0.1:${port}`);
  });
}
