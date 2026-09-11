import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { expandHomePathWith } from "../pathExpansion.ts";

/**
 * Build a resolver for the absolute directory a project creates its new
 * worktrees in, or `undefined` when the server's own worktrees directory
 * applies. Services come in already resolved so callers can use it from a
 * service closure without widening their own requirements.
 */
export const makeProjectWorktreeRootResolver = (services: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly path: Path.Path;
}) =>
  Effect.fn("resolveProjectWorktreeRoot")(function* (workspaceRoot: string) {
    const project = yield* services.projectionSnapshotQuery
      .getActiveProjectByWorkspaceRoot(workspaceRoot)
      .pipe(
        // Losing the preferred location is recoverable; losing the thread is not.
        Effect.catch((cause) =>
          Effect.logWarning("failed to read project worktree root; using the default location", {
            workspaceRoot,
            cause,
          }).pipe(Effect.as(Option.none())),
        ),
      );

    const configured = Option.getOrUndefined(project)?.worktreeRoot;
    if (configured == null) return undefined;

    // The contract accepts every platform's absolute form, because any client
    // can edit a project it does not host. Only this server knows which of
    // those forms its own path module understands: a Windows root reaching a
    // POSIX server would resolve under the server's cwd rather than fail, so
    // the default location is the safer answer.
    const expanded = expandHomePathWith(configured, services.path);
    if (!services.path.isAbsolute(expanded)) {
      yield* Effect.logWarning(
        "project worktree location is not absolute on this server; using the default location",
        { workspaceRoot, worktreeRoot: configured },
      );
      return undefined;
    }

    return services.path.resolve(expanded);
  });
