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

/**
 * Well-known macOS binary directories that should always be on PATH
 * so that tools installed via Homebrew are discoverable even when the
 * app is launched from the Dock / Finder (which inherits a minimal PATH).
 */
export const COMMON_MACOS_PATHS = [
  "/opt/homebrew/bin", // Apple Silicon Homebrew
  "/opt/homebrew/sbin",
  "/usr/local/bin", // Intel Homebrew / user binaries
  "/usr/local/sbin",
] as const;

/**
 * Append any missing well-known macOS binary directories to
 * `process.env.PATH`.  This is a no-op on non-darwin platforms.
 */
export function ensureCommonMacPaths(): void {
  if (process.platform !== "darwin") return;

  const currentPath = process.env.PATH ?? "";
  const currentDirs = new Set(currentPath.split(":").filter(Boolean));
  const missing = COMMON_MACOS_PATHS.filter((p) => !currentDirs.has(p));

  if (missing.length > 0) {
    process.env.PATH = [currentPath, ...missing].filter(Boolean).join(":");
  }
}
