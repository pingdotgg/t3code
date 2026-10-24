import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
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

/**
 * Where an agent works for a thread. A worktree checks out the whole
 * repository, so a project rooted in a repository subdirectory keeps that
 * subdirectory inside the worktree; its files and skills live there.
 * `repositoryRoot` is the checkout containing `projectRoot`, when known.
 */
export function threadAgentCwd(input: {
  readonly projectRoot: string;
  readonly repositoryRoot?: string | null | undefined;
  readonly worktreePath: string | null;
}): string {
  const { projectRoot, repositoryRoot, worktreePath } = input;
  if (worktreePath === null) return projectRoot;
  if (!repositoryRoot) return worktreePath;
  const separator = projectRoot.includes("\\") && !projectRoot.includes("/") ? "\\" : "/";
  const root = trimTrailingSeparators(repositoryRoot);
  if (projectRoot.length <= root.length + 1 || !projectRoot.startsWith(root)) return worktreePath;
  if (!isSeparator(projectRoot[root.length])) return worktreePath;
  const relative = trimTrailingSeparators(projectRoot.slice(root.length + 1));
  if (relative === "" || relative.split(/[\\/]/).includes("..")) return worktreePath;
  return `${trimTrailingSeparators(worktreePath)}${separator}${relative}`;
}

function isSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

// A scan rather than /[\\/]+$/, which backtracks quadratically on long separator runs.
function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && isSeparator(value[end - 1])) end -= 1;
  return value.slice(0, end);
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

export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}

/**
 * Leading spaces omit scripts from Bash history with ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish. Only the first line is prefixed, so later
 * entries from multiline input may still enter history. PowerShell/PSReadLine history is not suppressed.
 */
export function projectScriptTerminalInput(command: string): string {
  return ` ${command}\r`;
}
