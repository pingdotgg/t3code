import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

/**
 * Whether the server would accept this as an absolute worktree root, mirroring
 * its platform-native `NodePath.isAbsolute`: on Windows a leading separator,
 * drive letter or UNC root all count; on POSIX only a leading `/`. `~`, `~/…`
 * and `~\…` mirror `expandHomePath`, which doesn't understand `~user`.
 */
export function isAbsoluteWorktreeLocation(
  value: string,
  os: ExecutionEnvironmentPlatformOs,
): boolean {
  if (/^~(?:[/\\]|$)/.test(value)) return true;
  return os === "windows" ? /^(?:[/\\]|[A-Za-z]:[\\/])/.test(value) : value.startsWith("/");
}
