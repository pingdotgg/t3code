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
  input: ServerProviderSkillInventoryInput,
): Effect.fn.Return<string, ServerProviderSkillInventoryError, ProjectionSnapshotQuery> {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const { scope } = input;

  if (scope.kind === "project") {
    const project = yield* projectionSnapshotQuery.getProjectShellById(scope.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderSkillInventoryError({
            failure: "project_read_model_unavailable",
            instanceId: input.instanceId,
            scope,
            cause,
          }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* new ServerProviderSkillInventoryError({
        failure: "unknown_project",
        instanceId: input.instanceId,
        scope,
      });
    }
    return project.value.workspaceRoot;
  }

  const threadContext = yield* projectionSnapshotQuery
    .getThreadWorkspaceContextById(scope.threadId)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ServerProviderSkillInventoryError({
            failure: "thread_read_model_unavailable",
            instanceId: input.instanceId,
            scope,
            cause,
          }),
      ),
    );
  if (Option.isNone(threadContext)) {
    return yield* new ServerProviderSkillInventoryError({
      failure: "unknown_thread",
      instanceId: input.instanceId,
      scope,
    });
  }

  const cwd = resolveThreadWorkspaceCwd({
    thread: threadContext.value,
    projects:
      threadContext.value.workspaceRoot === null
        ? []
        : [
            {
              id: threadContext.value.projectId,
              workspaceRoot: threadContext.value.workspaceRoot,
            },
          ],
  });
  if (cwd === undefined) {
    return yield* new ServerProviderSkillInventoryError({
      failure: "unresolvable_workspace",
      instanceId: input.instanceId,
      scope,
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
      failure: "unknown_instance",
      instanceId: input.instanceId,
      scope: input.scope,
    });
  }

  // Snapshot-mode providers never reach the filesystem, and must not pay for
  // resolving a cwd they will not use.
  if (instance.skillInventory === undefined) {
    const snapshot = yield* instance.snapshot.getSnapshot;
    return snapshot.skills;
  }

  const cwd = yield* resolveInventoryCwd(input);
  return yield* instance.skillInventory.list({ cwd });
});
