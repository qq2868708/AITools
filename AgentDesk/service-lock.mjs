import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function acquireServiceLock(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "service.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try { descriptor = openSync(file, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw new Error("Cannot create platform service lock.");
      let owner;
      try { owner = JSON.parse(readFileSync(file, "utf8")); }
      catch { throw new Error("The API platform is already starting."); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid platform service lock.");
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
      if (alive) throw new Error("The API platform is already running.");
      try { unlinkSync(file); } catch {}
      continue;
    }
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    closeSync(descriptor);
    return () => {
      try {
        const owner = JSON.parse(readFileSync(file, "utf8"));
        if (owner.pid === process.pid) unlinkSync(file);
      } catch {}
    };
  }
  throw new Error("The API platform is already starting.");
}
