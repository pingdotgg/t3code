import type { ProjectScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
    /** Non-primary source folders, primary excluded. */
    additionalFolders?: readonly string[];
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
    // Stays the primary folder: existing scripts depend on it being one path.
    // Scripts that want the whole set opt into T3CODE_PROJECT_FOLDERS.
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  const additionalFolders = input.project.additionalFolders ?? [];
  if (additionalFolders.length > 0) {
    // A JSON array rather than a separator-joined string: Windows paths contain
    // ':' after the drive letter, so no single separator is safe everywhere.
    env.T3CODE_PROJECT_FOLDERS = JSON.stringify([input.project.cwd, ...additionalFolders]);
  }
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
