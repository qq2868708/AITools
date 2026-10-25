import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export async function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(new URL("./read-key.ps1", import.meta.url))
    ], { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
    return stdout.trim();
  } catch {
    throw new Error("Cannot read local credentials. Run setup-key.cmd under this Windows account.");
  }
}
