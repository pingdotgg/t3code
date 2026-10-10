import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Isolates long-lived agent and terminal processes from the server on Linux.
 *
 * Each wrapped command runs with a high `oom_score_adj`, so the kernel OOM
 * killer picks it before the server. Under a systemd user manager it also runs
 * in its own transient scope, so systemd-oomd (which kills whole leaf cgroups)
 * kills one agent instead of the server and every other agent.
 *
 * The server provides the real implementation. The default leaves commands
 * unchanged, which is also the behavior on macOS, Windows, and in tests.
 */
export interface AgentScopeShape {
  /**
   * Wraps the command that starts an agent or terminal. `name` labels the
   * scope unit, for example "claude" or "terminal". `env` is the environment
   * the command will run with, used to resolve it on PATH. A command that does
   * not resolve stays unwrapped, so a missing binary still fails at spawn.
   */
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly name: string;
    readonly threadId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  }) => Effect.Effect<AgentScopeCommand>;
  /**
   * Whether the latest agent scope of this thread was killed because the
   * machine or the agents slice ran out of memory. The answer holds until the
   * thread launches its next agent, so a retried failure reads the same.
   */
  readonly oomKilled: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Forgets the thread's scope. The session manager calls it before it opens
   * a provider session, so a scope only answers for the session that launched
   * it, even when the next session runs without one (Cursor, OpenCode).
   */
  readonly clear: (threadId: string) => Effect.Effect<void>;
}

export interface AgentScopeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const AgentScope = Context.Reference<AgentScopeShape>("@t3tools/shared/AgentScope", {
  defaultValue: () => ({
    wrap: ({ command, args }) => Effect.succeed({ command, args }),
    oomKilled: () => Effect.succeed(false),
    clear: () => Effect.void,
  }),
});

/**
 * The thread an ACP runtime is spawned for. ACP runtimes are shared by several
 * provider flavors and do not take a thread id, so the ACP adapter provides it.
 */
export const AgentScopeThreadId = Context.Reference<string | undefined>(
  "@t3tools/shared/AgentScope/ThreadId",
  { defaultValue: () => undefined },
);

/**
 * Agents get this `oom_score_adj` so the kernel kills them before the server.
 * An unprivileged process may raise its own score, never lower it.
 */
export const AGENT_OOM_SCORE_ADJ = 800;

/** Shell line that raises the score of the current process, ignoring failure. */
export const RAISE_OOM_SCORE_LINE = `{ echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`;

const LAUNCH_SCRIPT = [RAISE_OOM_SCORE_LINE, 'exec "$@"'].join("\n");

// systemd-run needs XDG_RUNTIME_DIR to reach the user manager. Fill it in when
// the agent environment does not carry it; it is the same user either way.
const SCOPED_LAUNCH_SCRIPT = [
  RAISE_OOM_SCORE_LINE,
  ': "${XDG_RUNTIME_DIR:=$1}"',
  "export XDG_RUNTIME_DIR",
  "shift",
  'exec "$@"',
].join("\n");

export interface AgentSystemdScope {
  readonly systemdRun: string;
  readonly slice: string;
  readonly unit: string;
  readonly runtimeDir: string;
  /** Extra `systemd-run` options, such as `--property=OOMPolicy=stop`. */
  readonly options: ReadonlyArray<string>;
}

/**
 * Builds the Linux launch for an agent command. Every step `exec`s, so the
 * spawned PID, stdio, and signals all belong to the agent itself.
 * `systemd-run --scope` registers its own PID as the scope and then runs the
 * command, so the agent and all of its children start inside the scope.
 */
export function agentScopeCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly scope?: AgentSystemdScope | undefined;
}): AgentScopeCommand {
  const { command, args, scope } = input;
  if (scope === undefined) {
    return { command: "/bin/sh", args: ["-c", LAUNCH_SCRIPT, "t3-agent", command, ...args] };
  }
  return {
    command: "/bin/sh",
    args: [
      "-c",
      SCOPED_LAUNCH_SCRIPT,
      "t3-agent",
      scope.runtimeDir,
      scope.systemdRun,
      "--user",
      "--scope",
      "--quiet",
      `--slice=${scope.slice}`,
      `--unit=${scope.unit}`,
      ...scope.options,
      "--",
      command,
      ...args,
    ],
  };
}
