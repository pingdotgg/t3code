import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `access-analyzer:CheckNoPublicAccess`.
 *
 * Custom policy check: verifies a resource policy cannot grant public access
 * for the given resource type. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.CheckNoPublicAccessHttp)`.
 * @binding
 * @section Custom Policy Checks
 * @example Assert a Bucket Policy Is Not Public
 * ```typescript
 * const checkNoPublicAccess =
 *   yield* AWS.AccessAnalyzer.CheckNoPublicAccess();
 * const result = yield* checkNoPublicAccess({
 *   policyDocument: JSON.stringify(bucketPolicy),
 *   resourceType: "AWS::S3::Bucket",
 * });
 * ```
 */
export interface CheckNoPublicAccess extends Binding.Service<
  CheckNoPublicAccess,
  "AWS.AccessAnalyzer.CheckNoPublicAccess",
  () => Effect.Effect<
    (
      request: aa.CheckNoPublicAccessRequest,
    ) => Effect.Effect<
      aa.CheckNoPublicAccessResponse,
      aa.CheckNoPublicAccessError
    >
  >
> {}

export const CheckNoPublicAccess = Binding.Service<CheckNoPublicAccess>(
  "AWS.AccessAnalyzer.CheckNoPublicAccess",
);
