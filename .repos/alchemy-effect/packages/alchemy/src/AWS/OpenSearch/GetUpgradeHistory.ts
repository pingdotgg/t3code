import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetUpgradeHistory` operation (IAM action
 * `es:GetUpgradeHistory`).
 *
 * Lists a domain's past engine-version upgrades and upgrade-eligibility checks, with per-step progress. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetUpgradeHistoryHttp)`.
 * @binding
 * @section Engine Upgrades
 * @example List Past Upgrades
 * ```typescript
 * const getUpgradeHistory = yield* OpenSearch.GetUpgradeHistory();
 *
 * const result = yield* getUpgradeHistory({ DomainName: name });
 * // result.UpgradeHistories → past upgrades
 * ```
 */
export interface GetUpgradeHistory extends Binding.Service<
  GetUpgradeHistory,
  "AWS.OpenSearch.GetUpgradeHistory",
  () => Effect.Effect<
    (
      request: opensearch.GetUpgradeHistoryRequest,
    ) => Effect.Effect<
      opensearch.GetUpgradeHistoryResponse,
      opensearch.GetUpgradeHistoryError
    >
  >
> {}
export const GetUpgradeHistory = Binding.Service<GetUpgradeHistory>(
  "AWS.OpenSearch.GetUpgradeHistory",
);
