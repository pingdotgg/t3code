// @effect-diagnostics nodeBuiltinImport:off -- Unique scope names are generated at the process boundary.
import * as NodeCrypto from "node:crypto";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

// Move the launcher before exec, so even the workload's first children inherit
// its scope. A separate helper performs the D-Bus call and waits for the start
// job. Failure (including missing tools/user bus) simply leaves the launcher in
// its original cgroup. Never retry the workload itself: a nonzero exit may have
// already performed side effects. exec preserves the PID, stdio and signals.
const SCOPE_LAUNCHER = `
timeout 3s /bin/sh -c '
  busctl --user --timeout=2s call org.freedesktop.systemd1 \\
    /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager \\
    StartTransientUnit "ssa(sv)a(sa(sv))" "$1" fail 3 \\
    PIDs au 1 "$2" Slice s app.slice CollectMode s inactive-or-failed 0 &&
  systemctl --user --no-ask-password start "$1"
' t3code-scope "$1" "$$" </dev/null >/dev/null 2>&1
shift
exec "$@"
`;

/** Only long-lived local workload roots belong here, not utility commands. */
export function taskScopeCommand(
  command: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
) {
  return platform === "linux"
    ? {
        command: "/bin/sh",
        args: [
          "-c",
          SCOPE_LAUNCHER,
          "t3code-task",
          `t3code-task-${NodeCrypto.randomUUID()}.scope`,
          command,
          ...args,
        ],
      }
    : { command, args };
}

export const resolveTaskSpawnCommand = Effect.fn("resolveTaskSpawnCommand")(function* (
  ...input: Parameters<typeof resolveSpawnCommand>
) {
  const resolved = yield* resolveSpawnCommand(...input);
  const platform = yield* HostProcessPlatform;
  return { ...resolved, ...taskScopeCommand(resolved.command, resolved.args, platform) };
});
