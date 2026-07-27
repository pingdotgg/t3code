import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:CheckAccessNotGranted`.
 *
 * Custom policy check: verifies a policy does not grant the specified actions
 * or resource access. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.CheckAccessNotGrantedHttp)`.
 * @binding
 * @section Custom Policy Checks
 * @example Assert a Policy Cannot Delete Buckets
 * ```typescript
 * const checkAccessNotGranted =
 *   yield* AWS.AccessAnalyzer.CheckAccessNotGranted();
 * const result = yield* checkAccessNotGranted({
 *   policyDocument: JSON.stringify(policy),
 *   policyType: "IDENTITY_POLICY",
 *   access: [{ actions: ["s3:DeleteBucket"] }],
 * });
 * // result.result === "PASS" | "FAIL"
 * ```
 */
export interface CheckAccessNotGranted extends Binding.Service<
  CheckAccessNotGranted,
  "AWS.AccessAnalyzer.CheckAccessNotGranted",
  () => Effect.Effect<
    (
      request: aa.CheckAccessNotGrantedRequest,
    ) => Effect.Effect<
      aa.CheckAccessNotGrantedResponse,
      aa.CheckAccessNotGrantedError
    >
  >
> {}

export const CheckAccessNotGranted = Binding.Service<CheckAccessNotGranted>(
  "AWS.AccessAnalyzer.CheckAccessNotGranted",
);
