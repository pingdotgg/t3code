import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SyncConfiguration } from "./SyncConfiguration.ts";

/**
 * Runtime binding for `codeconnections:GetSyncBlockerSummary`.
 *
 * Bind this operation to a {@link SyncConfiguration} to read the latest
 * sync blockers — errors that stop Git sync from converging the resource —
 * from inside a function runtime. Pair with {@link UpdateSyncBlocker} to
 * resolve them. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.GetSyncBlockerSummaryHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example Read the Latest Sync Blockers
 * ```typescript
 * // init — bind the operation to the sync configuration
 * const getSyncBlockerSummary =
 *   yield* AWS.CodeConnections.GetSyncBlockerSummary(sync);
 *
 * // runtime
 * const { SyncBlockerSummary } = yield* getSyncBlockerSummary();
 * const blockers = SyncBlockerSummary.LatestBlockers ?? [];
 * ```
 */
export interface GetSyncBlockerSummary extends Binding.Service<
  GetSyncBlockerSummary,
  "AWS.CodeConnections.GetSyncBlockerSummary",
  (
    syncConfiguration: SyncConfiguration,
  ) => Effect.Effect<
    () => Effect.Effect<
      codeconnections.GetSyncBlockerSummaryOutput,
      codeconnections.GetSyncBlockerSummaryError
    >
  >
> {}

export const GetSyncBlockerSummary = Binding.Service<GetSyncBlockerSummary>(
  "AWS.CodeConnections.GetSyncBlockerSummary",
);
