import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:DescribeComplianceByResource` — read whether
 * evaluated resources comply with the Config rules that evaluate them.
 *
 * Provide `Config.DescribeComplianceByResourceHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Check Resource Compliance
 * ```typescript
 * // init — grants config:DescribeComplianceByResource
 * const describeComplianceByResource = yield* AWS.Config.DescribeComplianceByResource();
 *
 * // runtime
 * const result = yield* describeComplianceByResource({
 *   ResourceType: "AWS::S3::Bucket",
 * });
 * console.log(result.ComplianceByResources);
 * ```
 */
export interface DescribeComplianceByResource extends Binding.Service<
  DescribeComplianceByResource,
  "AWS.Config.DescribeComplianceByResource",
  () => Effect.Effect<
    (
      request?: config.DescribeComplianceByResourceRequest,
    ) => Effect.Effect<
      config.DescribeComplianceByResourceResponse,
      config.DescribeComplianceByResourceError
    >
  >
> {}

export const DescribeComplianceByResource =
  Binding.Service<DescribeComplianceByResource>(
    "AWS.Config.DescribeComplianceByResource",
  );
