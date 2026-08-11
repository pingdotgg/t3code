/**
 * Resolve workspace directories used for skill discovery on provider probes.
 *
 * Discovers across registered project roots and active thread worktrees so
 * project skills are available in the provider snapshot. Each project skill
 * is tagged with its `sourceCwd`; clients filter the `$` picker to the
 * active chat's worktree or project root (see filterProviderSkillsForWorkspace).
 *
 * @module provider/Drivers/SkillWorkspaceCwds
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Unique absolute workspace paths for skill discovery:
 * 1. ServerConfig.cwd (bootstrap / fallback)
 * 2. Every active project `workspaceRoot`
 * 3. Every active thread `worktreePath`
 *
 * Best-effort: projection read failures still return the server cwd.
 */
export const resolveSkillWorkspaceCwds: Effect.Effect<
  ReadonlyArray<string>,
  never,
  ServerConfig | ProjectionSnapshotQuery | Path.Path
> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const projection = yield* ProjectionSnapshotQuery;

  const resolved = new Set<string>();
  resolved.add(path.resolve(serverConfig.cwd));

  if (projection.getActiveWorkspaceCwds) {
    const workspaceCwds = yield* projection
      .getActiveWorkspaceCwds()
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const workspaceCwd of workspaceCwds) {
      const trimmed = workspaceCwd.trim();
      if (trimmed.length > 0) {
        resolved.add(path.resolve(trimmed));
      }
    }
    return [...resolved];
  }

  // Compatibility fallback for lightweight/test query implementations.
  const shell = yield* projection.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));

  if (shell) {
    for (const project of shell.projects) {
      const root = project.workspaceRoot.trim();
      if (root.length > 0) {
        resolved.add(path.resolve(root));
      }
    }
    for (const thread of shell.threads) {
      const worktree = thread.worktreePath?.trim() ?? "";
      if (worktree.length > 0) {
        resolved.add(path.resolve(worktree));
      }
    }
  }

  return [...resolved];
}).pipe(Effect.withSpan("resolveSkillWorkspaceCwds"));
