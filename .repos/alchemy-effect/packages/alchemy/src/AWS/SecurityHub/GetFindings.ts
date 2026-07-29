import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetFindings`.
 *
 * Returns findings that match the specified filter criteria. With cross-Region aggregation enabled, the home Region returns matching findings from all linked Regions.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Query High-Severity Findings
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindings = yield* AWS.SecurityHub.GetFindings();
 *
 * // runtime
 * const { Findings } = yield* getFindings({
 *   Filters: { SeverityLabel: [{ Value: "HIGH", Comparison: "EQUALS" }] },
 *   MaxResults: 25,
 * });
 * ```
 */
export interface GetFindings extends Binding.Service<
  GetFindings,
  "AWS.SecurityHub.GetFindings",
  () => Effect.Effect<
    (
      request?: securityhub.GetFindingsRequest,
    ) => Effect.Effect<
      securityhub.GetFindingsResponse,
      securityhub.GetFindingsError
    >
  >
> {}
export const GetFindings = Binding.Service<GetFindings>(
  "AWS.SecurityHub.GetFindings",
);
