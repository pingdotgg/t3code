import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ValidateTemplate` operation (IAM action
 * `cloudformation:ValidateTemplate` on `*` — validation is not
 * resource-scoped).
 *
 * Validates a template body or URL and reports its parameters, capabilities,
 * and declaration errors — e.g. a platform service that lints user-submitted
 * templates before deploying them. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.ValidateTemplateHttp)`.
 * @binding
 * @section Validating Templates
 * @example Validate a Template Body
 * ```typescript
 * const validateTemplate = yield* AWS.CloudFormation.ValidateTemplate();
 *
 * const { Parameters, Capabilities } = yield* validateTemplate({
 *   TemplateBody: templateJson,
 * });
 * ```
 */
export interface ValidateTemplate extends Binding.Service<
  ValidateTemplate,
  "AWS.CloudFormation.ValidateTemplate",
  () => Effect.Effect<
    (
      request: cloudformation.ValidateTemplateInput,
    ) => Effect.Effect<
      cloudformation.ValidateTemplateOutput,
      cloudformation.ValidateTemplateError
    >
  >
> {}
export const ValidateTemplate = Binding.Service<ValidateTemplate>(
  "AWS.CloudFormation.ValidateTemplate",
);
