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

export function shouldHydratePathFromLoginShell(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function resolveLoginShell(
  platform: NodeJS.Platform,
  shell: string | undefined,
): string | undefined {
  const trimmedShell = shell?.trim();
  if (trimmedShell) {
    return trimmedShell;
  }

  if (platform === "darwin") {
    return "/bin/zsh";
  }

  if (platform === "linux") {
    return "/bin/bash";
  }

  return undefined;
}

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
  const output = execFile(shell, ["-ilc", PATH_CAPTURE_COMMAND], {
    encoding: "utf8",
    timeout: 5000,
  });
  return extractPathFromShellOutput(output) ?? undefined;
}

export function readPathForDesktopRuntime(
  platform: NodeJS.Platform,
  shell: string | undefined,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  if (!shouldHydratePathFromLoginShell(platform)) {
    return undefined;
  }

  const resolvedShell = resolveLoginShell(platform, shell);
  if (!resolvedShell) {
    return undefined;
  }

  return readPathFromLoginShell(resolvedShell, execFile);
}
