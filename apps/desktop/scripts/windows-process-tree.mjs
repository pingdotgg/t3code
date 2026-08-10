import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export function resolveTaskkillExecutable(env = process.env) {
  const windowsRoot = env.SystemRoot?.trim() || env.WINDIR?.trim();
  return windowsRoot
    ? NodePath.win32.join(windowsRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
}

export function terminateWindowsProcessTree(
  pid,
  { force = false, env = process.env, spawnSync = NodeChildProcess.spawnSync } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { attempted: false, ok: false, status: null };
  }

  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  const result = spawnSync(resolveTaskkillExecutable(env), args, {
    stdio: "ignore",
    windowsHide: true,
  });

  return {
    attempted: true,
    ok: result.status === 0,
    status: result.status,
  };
}
