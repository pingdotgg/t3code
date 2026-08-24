import type * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for the `CreateGraphSnapshot` operation (IAM actions `neptune-graph:CreateGraphSnapshot` + `neptune-graph:TagResource`),
 * scoped to one {@link Graph}.
 *
 * Takes an on-demand snapshot of the bound graph — e.g. a pre-import backup from an operational Lambda. Snapshot creation is asynchronous; poll it with {@link GetGraphSnapshot}. Provide the implementation with
 * `Effect.provide(AWS.NeptuneGraph.CreateGraphSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take an on-demand snapshot
 * ```typescript
 * const createSnapshot = yield* NeptuneGraph.CreateGraphSnapshot(graph);
 *
 * const snapshot = yield* createSnapshot({ snapshotName: "pre-import" });
 * // snapshot.status → "CREATING"
 * ```
 */
export interface CreateGraphSnapshot extends Binding.Service<
  CreateGraphSnapshot,
  "AWS.NeptuneGraph.CreateGraphSnapshot",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<neptunegraph.CreateGraphSnapshotInput, "graphIdentifier">,
    ) => Effect.Effect<
      neptunegraph.CreateGraphSnapshotOutput,
      neptunegraph.CreateGraphSnapshotError
    >
  >
> {}
export const CreateGraphSnapshot = Binding.Service<CreateGraphSnapshot>(
  "AWS.NeptuneGraph.CreateGraphSnapshot",
);
