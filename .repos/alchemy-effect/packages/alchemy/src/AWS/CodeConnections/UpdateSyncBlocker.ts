import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SyncConfiguration } from "./SyncConfiguration.ts";

/**
 * Request for {@link UpdateSyncBlocker} — the blocker ID and resolution
 * reason; the sync configuration's identity is injected from the bound
 * resource.
 */
export interface UpdateSyncBlockerRequest extends Omit<
  codeconnections.UpdateSyncBlockerInput,
  "ResourceName" | "SyncType"
> {}

/**
 * Runtime binding for `codeconnections:UpdateSyncBlocker`.
 *
 * Bind this operation to a {@link SyncConfiguration} to resolve a sync
 * blocker (discovered via {@link GetSyncBlockerSummary}) so Git sync can
 * resume converging the resource. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.UpdateSyncBlockerHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example Resolve a Sync Blocker
 * ```typescript
 * // init — bind the operation to the sync configuration
 * const updateSyncBlocker = yield* AWS.CodeConnections.UpdateSyncBlocker(sync);
 *
 * // runtime
 * yield* updateSyncBlocker({
 *   Id: blocker.Id,
 *   ResolvedReason: "stack drift corrected manually",
 * });
 * ```
 */
export interface UpdateSyncBlocker extends Binding.Service<
  UpdateSyncBlocker,
  "AWS.CodeConnections.UpdateSyncBlocker",
  (
    syncConfiguration: SyncConfiguration,
  ) => Effect.Effect<
    (
      request: UpdateSyncBlockerRequest,
    ) => Effect.Effect<
      codeconnections.UpdateSyncBlockerOutput,
      codeconnections.UpdateSyncBlockerError
    >
  >
> {}

export const UpdateSyncBlocker = Binding.Service<UpdateSyncBlocker>(
  "AWS.CodeConnections.UpdateSyncBlocker",
);
