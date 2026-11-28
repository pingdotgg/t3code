import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

const FILE_SCRIPT_RUNNERS: Readonly<Record<string, string>> = {
  sh: "sh",
  bash: "bash",
  js: "node",
  mjs: "node",
  cjs: "node",
  py: "python3",
  rb: "ruby",
  pl: "perl",
  php: "php",
};

export function projectScriptFileCommand(path: string): string | null {
  // Double quotes work in POSIX, PowerShell and cmd; reject characters they expand differently.
  if (!path || /["$`%!^\\\x00-\x1f]/.test(path) || path.startsWith("/")) return null;
  if (path.split("/").some((part) => part === ".." || part === "." || !part)) return null;
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const runner = Object.hasOwn(FILE_SCRIPT_RUNNERS, extension) ? FILE_SCRIPT_RUNNERS[extension] : undefined;
  return runner ? `${runner} "./${path}"` : null;
}

export function projectScriptForFile(path: string): ProjectScript | null {
  const command = projectScriptFileCommand(path);
  if (command === null) return null;
  return {
    id: `file-${crypto.randomUUID().slice(0, 18)}`,
    name: path.split("/").at(-1) ?? path,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

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
