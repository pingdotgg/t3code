import {
  MAX_SCRIPT_ID_LENGTH,
  type ProjectScript,
  type T3ProjectFileScript,
} from "@t3tools/contracts";

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

function normalizeProjectScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeProjectScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (true) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }
}

export function projectScriptsFromFileScripts(
  fileScripts: ReadonlyArray<T3ProjectFileScript>,
): ReadonlyArray<ProjectScript> {
  const scripts: ProjectScript[] = [];

  for (const fileScript of fileScripts) {
    const runOnWorktreeCreate = fileScript.runOnWorktreeCreate ?? false;
    if (runOnWorktreeCreate) {
      for (let index = 0; index < scripts.length; index += 1) {
        const script = scripts[index];
        if (script?.runOnWorktreeCreate) {
          scripts[index] = { ...script, runOnWorktreeCreate: false };
        }
      }
    }

    const id = nextProjectScriptId(
      fileScript.name,
      scripts.map((script) => script.id),
    );
    scripts.push({
      id,
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate,
      ...(fileScript.previewUrl === undefined
        ? {}
        : {
            previewUrl: fileScript.previewUrl,
            autoOpenPreview: fileScript.autoOpenPreview ?? false,
          }),
    });
  }

  return scripts;
}
