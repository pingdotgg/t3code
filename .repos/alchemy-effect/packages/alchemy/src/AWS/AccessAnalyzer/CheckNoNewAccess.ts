import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:CheckNoNewAccess`.
 *
 * Custom policy check: verifies an updated policy grants no access beyond what
 * the existing policy allows. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.CheckNoNewAccessHttp)`.
 * @binding
 * @section Custom Policy Checks
 * @example Compare an Updated Policy Against the Existing One
 * ```typescript
 * const checkNoNewAccess = yield* AWS.AccessAnalyzer.CheckNoNewAccess();
 * const result = yield* checkNoNewAccess({
 *   existingPolicyDocument: JSON.stringify(existing),
 *   newPolicyDocument: JSON.stringify(proposed),
 *   policyType: "IDENTITY_POLICY",
 * });
 * ```
 */
export interface CheckNoNewAccess extends Binding.Service<
  CheckNoNewAccess,
  "AWS.AccessAnalyzer.CheckNoNewAccess",
  () => Effect.Effect<
    (
      request: aa.CheckNoNewAccessRequest,
    ) => Effect.Effect<aa.CheckNoNewAccessResponse, aa.CheckNoNewAccessError>
  >
> {}

export const CheckNoNewAccess = Binding.Service<CheckNoNewAccess>(
  "AWS.AccessAnalyzer.CheckNoNewAccess",
);
