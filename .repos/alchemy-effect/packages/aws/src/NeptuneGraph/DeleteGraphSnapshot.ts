import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `DeleteGraphSnapshot` operation (IAM action `neptune-graph:DeleteGraphSnapshot`).
 *
 * Deletes a graph snapshot by id — e.g. a retention Lambda pruning old backups found via {@link ListGraphSnapshots}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.DeleteGraphSnapshotHttp)`.
 * ### Managing Snapshots
 * **Example:** Prune an old snapshot
 * ```typescript
 * const deleteSnapshot = yield* NeptuneGraph.DeleteGraphSnapshot();
 *
 * yield* deleteSnapshot({ snapshotIdentifier });
 * ```
 *
 * @binding
 */
export interface DeleteGraphSnapshot extends Binding.Service<
  DeleteGraphSnapshot,
  "AWS.NeptuneGraph.DeleteGraphSnapshot",
  () => Effect.Effect<
    (
      request: neptunegraph.DeleteGraphSnapshotInput,
    ) => Effect.Effect<
      neptunegraph.DeleteGraphSnapshotOutput,
      neptunegraph.DeleteGraphSnapshotError
    >
  >
> {}
export const DeleteGraphSnapshot = Binding.Service<DeleteGraphSnapshot>(
  "AWS.NeptuneGraph.DeleteGraphSnapshot",
);
