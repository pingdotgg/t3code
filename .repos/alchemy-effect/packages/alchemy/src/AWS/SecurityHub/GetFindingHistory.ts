import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetFindingHistory`.
 *
 * Returns the history of a finding for up to 90 days — every update Security Hub or a provider applied to it.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetFindingHistoryHttp)`.
 * @binding
 * @section Working with Findings
 * @example Audit a Finding's History
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindingHistory = yield* AWS.SecurityHub.GetFindingHistory();
 *
 * // runtime
 * const { Records } = yield* getFindingHistory({
 *   FindingIdentifier: { Id: findingId, ProductArn: productArn },
 * });
 * ```
 */
export interface GetFindingHistory extends Binding.Service<
  GetFindingHistory,
  "AWS.SecurityHub.GetFindingHistory",
  () => Effect.Effect<
    (
      request?: securityhub.GetFindingHistoryRequest,
    ) => Effect.Effect<
      securityhub.GetFindingHistoryResponse,
      securityhub.GetFindingHistoryError
    >
  >
> {}
export const GetFindingHistory = Binding.Service<GetFindingHistory>(
  "AWS.SecurityHub.GetFindingHistory",
);
