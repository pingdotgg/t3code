import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface AgentScopeShape {
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly name: string;
    readonly threadId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /**
     * Set for terminals, so a job the user detached (tmux, nohup) outlives a
     * server restart. Agents leave it unset: the next server stops agents a
     * killed server left running before it resumes their sessions.
     */
    readonly survivesRestart?: boolean | undefined;
    /**
     * Keep a shared process running after a tool OOM when supported.
     * Falls back to ordinary scope behavior on older systemd.
     */
    readonly shared?: boolean | undefined;
  }) => Effect.Effect<AgentScopeCommand>;
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

export const AgentScopeThreadId = Context.Reference<string | undefined>(
  "@t3tools/shared/AgentScope/ThreadId",
  { defaultValue: () => undefined },
);

export const AGENT_OOM_SCORE_ADJ = 800;

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
  readonly options: ReadonlyArray<string>;
}

/**
 * Every step `exec`s, so the spawned PID, stdio, and signals all belong to the agent itself.
 * `systemd-run --scope` registers its own PID as the scope and then runs the command, so the
 * agent and all of its children start inside the scope.
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
