import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetGraphSnapshot` operation (IAM action `neptune-graph:GetGraphSnapshot`).
 *
 * Reads one graph snapshot by id — status, source graph, and encryption key. Snapshot ids are server-generated runtime data, so the grant spans the account's snapshots. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.GetGraphSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Poll a snapshot until available
 * ```typescript
 * const getSnapshot = yield* NeptuneGraph.GetGraphSnapshot();
 *
 * const snapshot = yield* getSnapshot({ snapshotIdentifier });
 * // snapshot.status → "AVAILABLE"
 * ```
 */
export interface GetGraphSnapshot extends Binding.Service<
  GetGraphSnapshot,
  "AWS.NeptuneGraph.GetGraphSnapshot",
  () => Effect.Effect<
    (
      request: neptunegraph.GetGraphSnapshotInput,
    ) => Effect.Effect<
      neptunegraph.GetGraphSnapshotOutput,
      neptunegraph.GetGraphSnapshotError
    >
  >
> {}
export const GetGraphSnapshot = Binding.Service<GetGraphSnapshot>(
  "AWS.NeptuneGraph.GetGraphSnapshot",
);
