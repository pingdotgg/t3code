import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SyncConfiguration } from "./SyncConfiguration.ts";

/**
 * Runtime binding for `codeconnections:GetResourceSyncStatus`.
 *
 * Bind this operation to a {@link SyncConfiguration} to read the sync
 * status of its Amazon Web Services resource — the desired state revision
 * and the latest successful/attempted syncs — from inside a function
 * runtime. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.GetResourceSyncStatusHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example Read the Resource's Sync Status
 * ```typescript
 * // init — bind the operation to the sync configuration
 * const getResourceSyncStatus =
 *   yield* AWS.CodeConnections.GetResourceSyncStatus(sync);
 *
 * // runtime
 * const { LatestSync } = yield* getResourceSyncStatus();
 * ```
 */
export interface GetResourceSyncStatus extends Binding.Service<
  GetResourceSyncStatus,
  "AWS.CodeConnections.GetResourceSyncStatus",
  (
    syncConfiguration: SyncConfiguration,
  ) => Effect.Effect<
    () => Effect.Effect<
      codeconnections.GetResourceSyncStatusOutput,
      codeconnections.GetResourceSyncStatusError
    >
  >
> {}

export const GetResourceSyncStatus = Binding.Service<GetResourceSyncStatus>(
  "AWS.CodeConnections.GetResourceSyncStatus",
);
