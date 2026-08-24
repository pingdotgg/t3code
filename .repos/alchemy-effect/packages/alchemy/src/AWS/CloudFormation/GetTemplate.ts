import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `GetTemplate` operation (IAM action
 * `cloudformation:GetTemplate`).
 *
 * Bind this operation to a {@link Stack} to read the deployed template body
 * from inside a function runtime — e.g. audit tooling that archives or diffs
 * the template actually running in the account. Provide the implementation
 * with `Effect.provide(AWS.CloudFormation.GetTemplateHttp)`.
 * @binding
 * @section Reading Stacks
 * @example Read the Deployed Template
 * ```typescript
 * const getTemplate = yield* AWS.CloudFormation.GetTemplate(stack);
 *
 * const { TemplateBody } = yield* getTemplate();
 * ```
 */
export interface GetTemplate extends Binding.Service<
  GetTemplate,
  "AWS.CloudFormation.GetTemplate",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request?: Omit<cloudformation.GetTemplateInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.GetTemplateOutput,
      cloudformation.GetTemplateError
    >
  >
> {}
export const GetTemplate = Binding.Service<GetTemplate>(
  "AWS.CloudFormation.GetTemplate",
);
