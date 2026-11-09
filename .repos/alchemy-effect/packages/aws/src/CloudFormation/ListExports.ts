import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `ListExports` operation (IAM action
 * `cloudformation:ListExports` on `*` — exports are account-scoped).
 *
 * Lists all cross-stack exported output values in the account and region —
 * runtime service discovery of values shared via `Fn::ImportValue`. Provide
 * the implementation with `Effect.provide(AWS.CloudFormation.ListExportsHttp)`.
 * ### Cross-Stack Exports
 * **Example:** Resolve an Exported Value
 * ```typescript
 * const listExports = yield* AWS.CloudFormation.ListExports();
 *
 * const { Exports } = yield* listExports();
 * const apiUrl = Exports?.find((e) => e.Name === "ApiUrl")?.Value;
 * ```
 *
 * @binding
 */
export interface ListExports extends Binding.Service<
  ListExports,
  "AWS.CloudFormation.ListExports",
  () => Effect.Effect<
    (
      request?: cloudformation.ListExportsInput,
    ) => Effect.Effect<cloudformation.ListExportsOutput, cloudformation.ListExportsError>
  >
> {}
export const ListExports = Binding.Service<ListExports>("AWS.CloudFormation.ListExports");
