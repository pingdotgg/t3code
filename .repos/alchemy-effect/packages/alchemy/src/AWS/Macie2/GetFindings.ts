import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetFindings`.
 *
 * Retrieves the details of one or more findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Hydrate Finding Details
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindings = yield* AWS.Macie2.GetFindings();
 *
 * // runtime
 * const { findings } = yield* getFindings({ findingIds });
 * ```
 */
export interface GetFindings extends Binding.Service<
  GetFindings,
  "AWS.Macie2.GetFindings",
  () => Effect.Effect<
    (
      request?: macie2.GetFindingsRequest,
    ) => Effect.Effect<macie2.GetFindingsResponse, macie2.GetFindingsError>
  >
> {}
export const GetFindings = Binding.Service<GetFindings>(
  "AWS.Macie2.GetFindings",
);
