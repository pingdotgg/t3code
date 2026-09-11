import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

/** Missing entries preserve existing actions; null explicitly resets a checkout to machine defaults. */
export function resolveProjectScripts(
  settings: Pick<ServerSettings, "defaultProjectScripts" | "projectScriptOverrides">,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectScriptOverrides[project.id];
  if (override === null) return settings.defaultProjectScripts;
  return (
    override ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts)
  );
}

export function projectScriptsInheritDefaults(
  settings: Pick<ServerSettings, "projectScriptOverrides">,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  const override = settings.projectScriptOverrides[project.id];
  return override === null || (override === undefined && project.scripts.length === 0);
}

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
