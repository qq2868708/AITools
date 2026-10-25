import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function transform(action, values) {
  if (!values.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(new URL("./vault.ps1", import.meta.url))
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error("Windows credential protection failed."));
      else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 15000);
    child.on("error", () => finish(true));
    child.stdin.on("error", () => finish(true));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 2_000_000) { child.kill(); finish(true); }
    });
    child.stderr.resume();
    child.on("close", code => {
      if (code !== 0) return finish(true);
      try {
        const result = JSON.parse(output);
        if (!Array.isArray(result) || result.length !== values.length || result.some(v => typeof v !== "string")) throw new Error();
        finish(false, result);
      } catch { finish(true); }
      output = "";
    });
    child.stdin.end(JSON.stringify({ action, values }));
  });
}

export const windowsVault = {
  protect: async value => (await transform("protect", [value]))[0],
  unprotectMany: values => transform("unprotect", values)
};
