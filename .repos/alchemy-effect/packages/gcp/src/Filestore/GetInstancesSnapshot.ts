import type * as file from "@distilled.cloud/gcp/file_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InstancesSnapshot } from "./InstancesSnapshot.ts";

export interface GetInstancesSnapshotRequest extends Omit<
  file.GetProjectsLocationsInstancesSnapshotsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Filestore `snapshots.get`.
 *
 * Bind this operation to an {@link InstancesSnapshot} in a
 * Function/Action init phase. Provide {@link GetInstancesSnapshotHttp}.
 *
 * ### Observing Snapshots
 * **Example:** Read the bound snapshot
 * ```typescript
 * const getSnapshot = yield* GCP.Filestore.GetInstancesSnapshot(snap);
 * const live = yield* getSnapshot();
 * ```
 *
 * @binding
 * @category Filestore
 */
export interface GetInstancesSnapshot extends Binding.Service<
  GetInstancesSnapshot,
  "GCP.Filestore.GetInstancesSnapshot",
  (
    snapshot: InstancesSnapshot,
  ) => Effect.Effect<
    (
      request?: GetInstancesSnapshotRequest,
    ) => Effect.Effect<
      file.Snapshot,
      file.GetProjectsLocationsInstancesSnapshotsError,
      RuntimeContext
    >
  >
> {}

export const GetInstancesSnapshot = Binding.Service<GetInstancesSnapshot>(
  "GCP.Filestore.GetInstancesSnapshot",
);
