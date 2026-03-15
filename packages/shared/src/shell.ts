import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const PATH_CAPTURE_COMMAND = [
  `printf '%s\n' '${PATH_CAPTURE_START}'`,
  "printenv PATH",
  `printf '%s\n' '${PATH_CAPTURE_END}'`,
].join("; ");
const LOGIN_SHELL_TIMEOUT_MS = 750;
const PATH_REPAIR_DEADLINE_MS = 2_000;
const LOGIN_SHELL_ARG_SETS = [
  ["-ilc", PATH_CAPTURE_COMMAND],
  ["-lc", PATH_CAPTURE_COMMAND],
] as const;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;
type LoginShellErrorReporter = (shell: string, args: ReadonlyArray<string>, error: unknown) => void;
type ShellPathResolveErrorReporter = (shell: string, error: unknown) => void;

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
  onError?: LoginShellErrorReporter,
): string | undefined {
  let lastError: unknown;
  for (const args of LOGIN_SHELL_ARG_SETS) {
    try {
      const output = execFile(shell, args, {
        encoding: "utf8",
        timeout: LOGIN_SHELL_TIMEOUT_MS,
      });
      const resolvedPath = extractPathFromShellOutput(output) ?? undefined;
      if (resolvedPath) {
        return resolvedPath;
      }
    } catch (error) {
      lastError = error;
      onError?.(shell, args, error);
    }
  }

  if (lastError) {
    throw lastError;
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
  const deadline = Date.now() + PATH_REPAIR_DEADLINE_MS;

  for (const shell of shells) {
    if (Date.now() >= deadline) {
      return undefined;
    }

    try {
      const result = readPathFromLoginShell(shell, execFile, (_failedShell, _args, error) => {
        onError?.(shell, error);
      });
      if (result) {
        return result;
      }
    } catch {
      // Per-attempt failures are already reported via onError when enabled.
    }
  }

  return undefined;
}

function pathEntries(pathValue: string | undefined): Set<string> {
  return new Set(
    (pathValue ?? "")
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function shouldRepairPath(
  platform = process.platform,
  pathValue = process.env.PATH,
  homePath = process.env.HOME ?? homedir(),
): boolean {
  if (platform !== "darwin" && platform !== "linux") {
    return false;
  }

  const entries = pathEntries(pathValue);
  if (entries.size === 0) {
    return true;
  }

  if (platform === "darwin") {
    return !entries.has("/opt/homebrew/bin") && !entries.has("/usr/local/bin");
  }

  return !entries.has(`${homePath}/.local/bin`) && !entries.has("/usr/local/bin");
}
