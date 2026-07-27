import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetComplianceDetailsByResource` — read the
 * per-rule evaluation results (who evaluated the resource, when, and the
 * verdict) for one resource.
 *
 * Provide `Config.GetComplianceDetailsByResourceHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Read a Resource's Evaluation Results
 * ```typescript
 * // init — grants config:GetComplianceDetailsByResource
 * const getComplianceDetailsByResource = yield* AWS.Config.GetComplianceDetailsByResource();
 *
 * // runtime
 * const result = yield* getComplianceDetailsByResource({
 *   ResourceType: "AWS::S3::Bucket",
 *   ResourceId: "my-bucket",
 * });
 * console.log(result.EvaluationResults);
 * ```
 */
export interface GetComplianceDetailsByResource extends Binding.Service<
  GetComplianceDetailsByResource,
  "AWS.Config.GetComplianceDetailsByResource",
  () => Effect.Effect<
    (
      request?: config.GetComplianceDetailsByResourceRequest,
    ) => Effect.Effect<
      config.GetComplianceDetailsByResourceResponse,
      config.GetComplianceDetailsByResourceError
    >
  >
> {}

export const GetComplianceDetailsByResource =
  Binding.Service<GetComplianceDetailsByResource>(
    "AWS.Config.GetComplianceDetailsByResource",
  );
