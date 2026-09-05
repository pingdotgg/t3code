import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `GetSnapshots` request with `IndexId` injected from the bound index.
 */
export interface GetSnapshotsRequest extends Omit<
  kendra.GetSnapshotsRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `GetSnapshots` operation (IAM action
 * `kendra:GetSnapshots`), scoped to one {@link Index}.
 *
 * Fetches search-analytics metric snapshots for the index (click-through
 * rate, zero-result queries, top queries, …) over a time interval.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.GetSnapshotsHttp)`.
 *
 * @binding
 * @section Search Analytics
 * @example Fetch Search Metrics
 * ```typescript
 * const getSnapshots = yield* AWS.Kendra.GetSnapshots(index);
 *
 * const metrics = yield* getSnapshots({
 *   Interval: "ONE_WEEK_AGO",
 *   MetricType: "QUERIES_BY_COUNT",
 * });
 * ```
 */
export interface GetSnapshots extends Binding.Service<
  GetSnapshots,
  "AWS.Kendra.GetSnapshots",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: GetSnapshotsRequest,
    ) => Effect.Effect<kendra.GetSnapshotsResponse, kendra.GetSnapshotsError>
  >
> {}
export const GetSnapshots = Binding.Service<GetSnapshots>(
  "AWS.Kendra.GetSnapshots",
);
