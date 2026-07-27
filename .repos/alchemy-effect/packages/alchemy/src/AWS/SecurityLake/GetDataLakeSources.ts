import type * as securitylake from "@distilled.cloud/aws/securitylake";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataLake } from "./DataLake.ts";

/**
 * Runtime binding for `securitylake:GetDataLakeSources`.
 *
 * Returns a snapshot of which log sources are collecting (per account and
 * source, with `COLLECTING` / `MISCONFIGURED` / `NOT_COLLECTING` statuses) so
 * a monitoring Function can verify ingestion health. Bind the account's
 * {@link DataLake}.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityLake.GetDataLakeSourcesHttp)`.
 * @binding
 * @section Monitoring the data lake
 * @example Check source collection status
 * ```typescript
 * // init
 * const getSources = yield* AWS.SecurityLake.GetDataLakeSources(lake);
 *
 * // runtime
 * const { dataLakeSources } = yield* getSources();
 * ```
 */
export interface GetDataLakeSources extends Binding.Service<
  GetDataLakeSources,
  "AWS.SecurityLake.GetDataLakeSources",
  (
    lake: DataLake,
  ) => Effect.Effect<
    (
      request?: securitylake.GetDataLakeSourcesRequest,
    ) => Effect.Effect<
      securitylake.GetDataLakeSourcesResponse,
      securitylake.GetDataLakeSourcesError
    >
  >
> {}
export const GetDataLakeSources = Binding.Service<GetDataLakeSources>(
  "AWS.SecurityLake.GetDataLakeSources",
);
