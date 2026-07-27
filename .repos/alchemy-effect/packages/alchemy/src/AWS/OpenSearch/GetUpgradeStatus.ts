import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetUpgradeStatus` operation (IAM action
 * `es:GetUpgradeStatus`).
 *
 * Reads the status of a domain's most recent engine-version upgrade or upgrade-eligibility check. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetUpgradeStatusHttp)`.
 * @binding
 * @section Engine Upgrades
 * @example Check an In-Progress Upgrade
 * ```typescript
 * const getUpgradeStatus = yield* OpenSearch.GetUpgradeStatus();
 *
 * const result = yield* getUpgradeStatus({ DomainName: name });
 * // result.StepStatus → "SUCCEEDED"
 * ```
 */
export interface GetUpgradeStatus extends Binding.Service<
  GetUpgradeStatus,
  "AWS.OpenSearch.GetUpgradeStatus",
  () => Effect.Effect<
    (
      request: opensearch.GetUpgradeStatusRequest,
    ) => Effect.Effect<
      opensearch.GetUpgradeStatusResponse,
      opensearch.GetUpgradeStatusError
    >
  >
> {}
export const GetUpgradeStatus = Binding.Service<GetUpgradeStatus>(
  "AWS.OpenSearch.GetUpgradeStatus",
);
