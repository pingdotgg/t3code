import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "./path.ts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
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

/**
 * Where a thread works: the project directory, or the same directory inside
 * the thread's worktree. A worktree checks out the whole repository, so a
 * project rooted at `<repo>/ios` works in `<worktree>/ios`. Without a known
 * repository root (or when the project sits outside it) this is the worktree.
 */
export function projectScriptCwd(input: {
  project: {
    cwd: string;
    repositoryRoot?: string | null | undefined;
  };
  worktreePath?: string | null;
}): string {
  const worktreePath = input.worktreePath;
  if (worktreePath == null) return input.project.cwd;
  const repositoryRoot = input.project.repositoryRoot?.trim();
  if (!repositoryRoot) return worktreePath;
  const subpath = repositoryRelativePath(input.project.cwd, repositoryRoot);
  if (!subpath) return worktreePath;
  const base = normalizeProjectPathForDispatch(worktreePath);
  const separator = isWindowsAbsolutePath(base) ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${subpath.replaceAll("/", separator)}`;
}

/**
 * The project's path below its repository root with `/` separators, "" for
 * the root itself, or null when the project is not inside the root.
 */
function repositoryRelativePath(projectCwd: string, repositoryRoot: string): string | null {
  const project = normalizeProjectPathForDispatch(projectCwd);
  const comparableProject = normalizeProjectPathForComparison(project);
  const comparableRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (comparableProject.length === 0 || comparableRoot.length === 0) return null;
  if (comparableProject === comparableRoot) return "";
  const separator = comparableRoot.includes("\\") ? "\\" : "/";
  const rootPrefix = comparableRoot.endsWith(separator)
    ? comparableRoot
    : `${comparableRoot}${separator}`;
  if (!comparableProject.startsWith(rootPrefix)) return null;
  // Comparison only lowercases and flips separators, so offsets line up with
  // the original path and the subpath keeps its case.
  return project.slice(rootPrefix.length).replaceAll("\\", "/");
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

/** Menu label naming the lifecycle roles a script runs in, e.g. "Clean (on settle)". */
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
