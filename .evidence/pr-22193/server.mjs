// Starts and stops one worktree's `vp run dev`, tracking only the process group it spawned.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";

export async function stopServer(pidFile) {
  if (!NodeFS.existsSync(pidFile)) return;
  const pgid = Number(NodeFS.readFileSync(pidFile, "utf8"));
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pgid, 0);
    } catch {
      break;
    }
    await NodeTimersPromises.setTimeout(250);
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
  NodeFS.rmSync(pidFile);
}

export async function startServer({ worktree, pidFile, logFile }) {
  const out = NodeFS.openSync(logFile, "w");
  const child = NodeChildProcess.spawn("vp", ["run", "dev"], {
    cwd: worktree,
    detached: true,
    stdio: ["ignore", out, out],
  });
  NodeFS.writeFileSync(pidFile, String(child.pid));
  child.unref();
  for (let i = 0; i < 240; i++) {
    const log = NodeFS.readFileSync(logFile, "utf8");
    if (
      /Listening on http/.test(log) &&
      /webPort=\d+/.test(log) &&
      /VITE|ready in|Local:/i.test(log)
    )
      break;
    if (/Listening on http/.test(log) && i > 20) break;
    await NodeTimersPromises.setTimeout(500);
  }
  // Vite and provider snapshots settle a little after the server listens.
  await NodeTimersPromises.setTimeout(4000);
}
