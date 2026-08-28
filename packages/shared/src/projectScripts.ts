import type { ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export type SetupScriptStatus = "running" | "succeeded" | "failed";

export interface SetupScriptState {
  readonly status: SetupScriptStatus;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logPath: string | null;
  readonly scriptName: string | null;
  readonly terminalId: string | null;
}

const SETUP_SCRIPT_ACTIVITY_KIND = {
  requested: "setup-script.requested",
  started: "setup-script.started",
  succeeded: "setup-script.succeeded",
  failed: "setup-script.failed",
} as const;

export function isSetupScriptActivityKind(kind: string): boolean {
  return kind.startsWith("setup-script.");
}

export function setupScriptStateFromActivities(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
  }>,
): SetupScriptState | null {
  let state: SetupScriptState | null = null;
  for (const activity of activities) {
    if (!isSetupScriptActivityKind(activity.kind)) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
    const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : null;
    const finishedAt = typeof payload.finishedAt === "string" ? payload.finishedAt : null;
    const logPath = typeof payload.logPath === "string" ? payload.logPath : null;
    const scriptName = typeof payload.scriptName === "string" ? payload.scriptName : null;
    const terminalId = typeof payload.terminalId === "string" ? payload.terminalId : null;
    if (activity.kind === SETUP_SCRIPT_ACTIVITY_KIND.succeeded) {
      state = {
        status: "succeeded",
        exitCode,
        startedAt,
        finishedAt,
        logPath,
        scriptName,
        terminalId,
      };
      continue;
    }
    if (activity.kind === SETUP_SCRIPT_ACTIVITY_KIND.failed) {
      state = {
        status: "failed",
        exitCode,
        startedAt,
        finishedAt,
        logPath,
        scriptName,
        terminalId,
      };
      continue;
    }
    state = {
      status: "running",
      exitCode: null,
      startedAt,
      finishedAt: null,
      logPath,
      scriptName,
      terminalId,
    };
  }
  return state;
}
