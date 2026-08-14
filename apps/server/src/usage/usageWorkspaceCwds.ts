import * as Effect from "effect/Effect";

interface UsageWorkspaceSnapshot {
  readonly projects: readonly { readonly workspaceRoot: string }[];
  readonly threads: readonly { readonly worktreePath: string | null }[];
}

/**
 * Load every cwd that may anchor a relative provider path. Projection data is
 * enrichment: if it is temporarily unavailable, usage can still scan default
 * and absolute homes using the server cwd as its only relative-path fallback.
 */
export const resolveUsageWorkspaceCwds = Effect.fn("resolveUsageWorkspaceCwds")(function* <E, R>(
  serverCwd: string,
  loadSnapshots: Effect.Effect<readonly UsageWorkspaceSnapshot[], E, R>,
) {
  const snapshots = yield* loadSnapshots.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to read project workspaces for usage", { error }).pipe(
        Effect.as([] as readonly UsageWorkspaceSnapshot[]),
      ),
    ),
  );
  const workspaceCwds = new Set([serverCwd]);
  for (const snapshot of snapshots) {
    for (const project of snapshot.projects) workspaceCwds.add(project.workspaceRoot);
    for (const thread of snapshot.threads) {
      if (thread.worktreePath !== null) workspaceCwds.add(thread.worktreePath);
    }
  }
  return [...workspaceCwds];
});
