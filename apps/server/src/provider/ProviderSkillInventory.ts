/**
 * ProviderSkillInventory — resolve a provider's skill inventory for the
 * directory an agent will actually run in.
 *
 * The `$` picker used to render `ServerProvider.skills`, an environment-wide
 * snapshot computed once from wherever the server started. That is wrong for
 * every project but one, and useless for Cursor, which reports no snapshot
 * skills at all.
 *
 * This module takes a thread or project identifier — never a path — resolves
 * it to a working directory with the same rule the provider session uses, and
 * asks the selected instance for its inventory there. Instances without the
 * capability fall back to their snapshot skills, so Codex and Claude keep
 * working unchanged.
 *
 * @module provider/ProviderSkillInventory
 */
import {
  type ServerProviderSkill,
  ServerProviderSkillInventoryError,
  type ServerProviderSkillInventoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

/** Wrap a read-model failure in the RPC's typed inventory error. */
const repositoryFailure = (reason: string) => (cause: unknown) =>
  new ServerProviderSkillInventoryError({ reason, cause });

/**
 * Resolve the inventory scope to the directory a provider session for that
 * scope would be started in.
 *
 * Thread scope reuses `resolveThreadWorkspaceCwd`, the same helper
 * `ProviderCommandReactor` uses, rather than re-deriving
 * `worktreePath ?? workspaceRoot` — a second copy would drift and the picker
 * would list the project root's skills for a worktree thread.
 */
const resolveInventoryCwd = Effect.fn("resolveInventoryCwd")(function* (
  scope: ServerProviderSkillInventoryInput["scope"],
): Effect.fn.Return<string, ServerProviderSkillInventoryError, ProjectionSnapshotQuery> {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  if (scope.kind === "project") {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(scope.projectId)
      .pipe(Effect.mapError(repositoryFailure("Failed to read the project read model.")));
    if (Option.isNone(project)) {
      return yield* new ServerProviderSkillInventoryError({
        reason: `Unknown project '${scope.projectId}'.`,
      });
    }
    return project.value.workspaceRoot;
  }

  const thread = yield* projectionSnapshotQuery
    .getThreadShellById(scope.threadId)
    .pipe(Effect.mapError(repositoryFailure("Failed to read the thread read model.")));
  if (Option.isNone(thread)) {
    return yield* new ServerProviderSkillInventoryError({
      reason: `Unknown thread '${scope.threadId}'.`,
    });
  }

  const project = yield* projectionSnapshotQuery
    .getProjectShellById(thread.value.projectId)
    .pipe(Effect.mapError(repositoryFailure("Failed to read the project read model.")));

  const cwd = resolveThreadWorkspaceCwd({
    thread: thread.value,
    projects: Option.isSome(project) ? [project.value] : [],
  });
  if (cwd === undefined) {
    return yield* new ServerProviderSkillInventoryError({
      reason: `Thread '${scope.threadId}' has no resolvable workspace directory.`,
    });
  }
  return cwd;
});

/**
 * Answer one `providers.skillInventory` request.
 *
 * Unknown scopes and unknown instances are typed failures. Discovery itself
 * cannot fail: a provider that scans the filesystem returns whatever it could
 * read, so a malformed skill costs that row and nothing else.
 */
export const resolveProviderSkillInventory = Effect.fn("resolveProviderSkillInventory")(function* (
  input: ServerProviderSkillInventoryInput,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  ServerProviderSkillInventoryError,
  ProjectionSnapshotQuery | ProviderInstanceRegistry
> {
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const instance = yield* instanceRegistry.getInstance(input.instanceId);
  if (instance === undefined) {
    return yield* new ServerProviderSkillInventoryError({
      reason: `Unknown provider instance '${input.instanceId}'.`,
    });
  }

  // Snapshot-mode providers never reach the filesystem, and must not pay for
  // resolving a cwd they will not use.
  if (instance.skillInventory === undefined) {
    const snapshot = yield* instance.snapshot.getSnapshot;
    return snapshot.skills;
  }

  const cwd = yield* resolveInventoryCwd(input.scope);
  return yield* instance.skillInventory.list({ cwd });
});
