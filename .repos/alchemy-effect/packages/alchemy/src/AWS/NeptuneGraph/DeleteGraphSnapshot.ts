import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteGraphSnapshot` operation (IAM action `neptune-graph:DeleteGraphSnapshot`).
 *
 * Deletes a graph snapshot by id — e.g. a retention Lambda pruning old backups found via {@link ListGraphSnapshots}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.DeleteGraphSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Prune an old snapshot
 * ```typescript
 * const deleteSnapshot = yield* NeptuneGraph.DeleteGraphSnapshot();
 *
 * yield* deleteSnapshot({ snapshotIdentifier });
 * ```
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
