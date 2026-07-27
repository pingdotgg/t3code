import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:PutEvaluations` — report evaluation results
 * to AWS Config from inside a custom Config rule's Lambda function, using
 * the `resultToken` the rule invocation delivered.
 *
 * Provide `Config.PutEvaluationsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reporting Evaluations (Custom Rules)
 * @example Report Evaluations from a Custom Rule
 * ```typescript
 * // init — grants config:PutEvaluations
 * const putEvaluations = yield* AWS.Config.PutEvaluations();
 *
 * // runtime
 * const result = yield* putEvaluations({
 *   ResultToken: event.resultToken,
 *   Evaluations: [
 *     {
 *       ComplianceResourceType: "AWS::S3::Bucket",
 *       ComplianceResourceId: "my-bucket",
 *       ComplianceType: "COMPLIANT",
 *       OrderingTimestamp: new Date(),
 *     },
 *   ],
 * });
 * console.log(result.FailedEvaluations);
 * ```
 */
export interface PutEvaluations extends Binding.Service<
  PutEvaluations,
  "AWS.Config.PutEvaluations",
  () => Effect.Effect<
    (
      request: config.PutEvaluationsRequest,
    ) => Effect.Effect<
      config.PutEvaluationsResponse,
      config.PutEvaluationsError
    >
  >
> {}

export const PutEvaluations = Binding.Service<PutEvaluations>(
  "AWS.Config.PutEvaluations",
);
