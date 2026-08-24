import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListImports` operation (IAM action
 * `cloudformation:ListImports` on `*` — imports are account-scoped).
 *
 * Lists the stacks importing a given exported output value — e.g. impact
 * analysis before rotating a shared value. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.ListImportsHttp)`.
 * @binding
 * @section Cross-Stack Exports
 * @example Find Stacks Importing an Export
 * ```typescript
 * const listImports = yield* AWS.CloudFormation.ListImports();
 *
 * const { Imports } = yield* listImports({ ExportName: "ApiUrl" });
 * ```
 */
export interface ListImports extends Binding.Service<
  ListImports,
  "AWS.CloudFormation.ListImports",
  () => Effect.Effect<
    (
      request: cloudformation.ListImportsInput,
    ) => Effect.Effect<
      cloudformation.ListImportsOutput,
      cloudformation.ListImportsError
    >
  >
> {}
export const ListImports = Binding.Service<ListImports>(
  "AWS.CloudFormation.ListImports",
);
