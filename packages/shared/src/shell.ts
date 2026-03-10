import { execFileSync } from "node:child_process";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const PATH_CAPTURE_COMMAND = [
  `printf '%s\n' '${PATH_CAPTURE_START}'`,
  "printenv PATH",
  `printf '%s\n' '${PATH_CAPTURE_END}'`,
].join("; ");

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

const LOGIN_SHELL_ARG_SETS = [
  ["-ilc", PATH_CAPTURE_COMMAND],
  ["-lc", PATH_CAPTURE_COMMAND],
] as const;

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  for (const args of LOGIN_SHELL_ARG_SETS) {
    try {
      const output = execFile(shell, args, {
        encoding: "utf8",
        timeout: 5000,
      });
      const resolvedPath = extractPathFromShellOutput(output) ?? undefined;
      if (resolvedPath) {
        return resolvedPath;
      }
    } catch {
      // Try the next shell invocation mode.
    }
  }

  return undefined;
}

function uniqueShellCandidates(candidates: ReadonlyArray<string | undefined>): string[] {
  const unique = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized.length === 0 || unique.has(normalized)) continue;
    unique.add(normalized);
  }

  return [...unique];
}

export function defaultShellCandidates(platform = process.platform): string[] {
  if (platform === "linux") {
    return uniqueShellCandidates([process.env.SHELL, "/bin/sh"]);
  }

  if (platform === "darwin") {
    return uniqueShellCandidates([process.env.SHELL, "/bin/zsh", "/bin/bash"]);
  }

  return uniqueShellCandidates([
    process.env.SHELL,
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
  ]);
}

type ShellPathResolveErrorReporter = (shell: string, error: unknown) => void;

const defaultShellPathErrorReporter: ShellPathResolveErrorReporter | undefined =
  process.env.T3CODE_DEBUG_SHELL_PATH === "1"
    ? (shell, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[shell] PATH resolution failed for ${shell}: ${message}`);
      }
    : undefined;

export function resolvePathFromLoginShells(
  shells: ReadonlyArray<string>,
  execFile: ExecFileSyncLike = execFileSync,
  onError: ShellPathResolveErrorReporter | undefined = defaultShellPathErrorReporter,
): string | undefined {
  for (const shell of shells) {
    try {
      const result = readPathFromLoginShell(shell, execFile);
      if (result) {
        return result;
      }
    } catch (error) {
      onError?.(shell, error);
      // Try next shell candidate.
    }
  }
  return undefined;
}
