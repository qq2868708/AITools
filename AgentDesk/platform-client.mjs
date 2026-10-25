import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PLATFORM_DIR } from "./providers.mjs";

async function connection() {
  try {
    const data = JSON.parse(readFileSync(join(PLATFORM_DIR, "runtime.json"), "utf8"));
    if (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535 || !/^[a-f0-9]{64}$/.test(data.token)) return null;
    const response = await fetch(`http://127.0.0.1:${data.port}/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
    if (!response.ok) return null;
    const health = await response.json();
    if (health.service !== "agent-api-platform") return null;
    return { ...data, version: health.version ?? 1 };
  } catch { return null; }
}

export async function ensurePlatform() {
  const existing = await connection();
  if (existing) return existing;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./monitor.mjs", import.meta.url))], {
    detached: true, windowsHide: true, stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
  for (let attempt = 0; attempt < 35; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const ready = await connection();
    if (ready) return ready;
  }
  throw new Error("API platform is unavailable. Run start-monitor.cmd and try again.");
}

export async function platformRpc(action, args = {}) {
  const { port, token, version } = await ensurePlatform();
  if (["task_trace", "task_retry"].includes(action) && version < 3) {
    throw new Error("Restart the local platform service to enable request records and recovery.");
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Platform-Token": token },
    body: JSON.stringify({ action, args }), redirect: "error", signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Platform request failed.");
  return result;
}
