/**
 * Resolve workspace directories used for skill discovery on provider probes.
 *
 * Discovers across registered project roots and active thread worktrees so
 * project skills are available in the provider snapshot. Each project skill
 * is tagged with its `sourceCwd`; clients filter the `$` picker to the
 * active chat's worktree or project root (see filterProviderSkillsForWorkspace).
 *
 * The server process cwd is a bootstrap root only: when no projects or
 * worktrees are registered yet, discovery still has something to scan. Once
 * real workspaces exist, the server's own directory would only add noise
 * (and payload) to every snapshot, so it is dropped.
 *
 * @module provider/Drivers/SkillWorkspaceCwds
 */
import type * as Path from "effect/Path";

export interface SkillWorkspaceCwdsInput {
  readonly path: Path.Path;
  /** `ServerConfig.cwd` — used only while no active workspace is known. */
  readonly serverCwd: string;
  /**
   * Active project `workspaceRoot`s and thread `worktreePath`s, typically
   * from `ProjectionSnapshotQuery.getActiveWorkspaceCwds`. Best-effort
   * callers pass an empty array on projection read failures.
   */
  readonly activeWorkspaceCwds: ReadonlyArray<string>;
}

/**
 * Unique absolute workspace paths for skill discovery:
 * 1. Every active project `workspaceRoot` and thread `worktreePath`.
 * 2. `serverCwd` as fallback when that set is empty.
 */
export function resolveSkillWorkspaceCwds(input: SkillWorkspaceCwdsInput): ReadonlyArray<string> {
  const resolved = new Set<string>();
  for (const workspaceCwd of input.activeWorkspaceCwds) {
    const trimmed = workspaceCwd.trim();
    if (trimmed.length > 0) {
      resolved.add(input.path.resolve(trimmed));
    }
  }
  if (resolved.size === 0) {
    const trimmedServerCwd = input.serverCwd.trim();
    if (trimmedServerCwd.length > 0) {
      resolved.add(input.path.resolve(trimmedServerCwd));
    }
  }
  return [...resolved];
}
