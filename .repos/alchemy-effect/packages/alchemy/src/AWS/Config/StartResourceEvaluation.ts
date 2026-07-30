import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:StartResourceEvaluation` — proactively
 * evaluate a hypothetical resource configuration against your PROACTIVE
 * Config rules before the resource is deployed.
 *
 * Provide `Config.StartResourceEvaluationHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Proactive Resource Evaluation
 * @example Evaluate a Resource Before Deploying
 * ```typescript
 * // init — grants config:StartResourceEvaluation
 * const startResourceEvaluation = yield* AWS.Config.StartResourceEvaluation();
 *
 * // runtime
 * const result = yield* startResourceEvaluation({
 *   EvaluationMode: "PROACTIVE",
 *   ResourceDetails: {
 *     ResourceId: "my-bucket",
 *     ResourceType: "AWS::S3::Bucket",
 *     ResourceConfiguration: JSON.stringify({
 *       BucketName: "my-bucket",
 *     }),
 *     ResourceConfigurationSchemaType: "CFN_RESOURCE_SCHEMA",
 *   },
 * });
 * console.log(result.ResourceEvaluationId);
 * ```
 */
export interface StartResourceEvaluation extends Binding.Service<
  StartResourceEvaluation,
  "AWS.Config.StartResourceEvaluation",
  () => Effect.Effect<
    (
      request: config.StartResourceEvaluationRequest,
    ) => Effect.Effect<
      config.StartResourceEvaluationResponse,
      config.StartResourceEvaluationError
    >
  >
> {}

export const StartResourceEvaluation = Binding.Service<StartResourceEvaluation>(
  "AWS.Config.StartResourceEvaluation",
);
