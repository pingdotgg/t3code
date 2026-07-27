import type * as cloudformation from "@distilled.cloud/aws/cloudformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stack } from "./Stack.ts";

/**
 * Runtime binding for the `SignalResource` operation (IAM action
 * `cloudformation:SignalResource`).
 *
 * Bind this operation to a {@link Stack} to send SUCCESS/FAILURE signals to a
 * resource with a `CreationPolicy` or a `WaitCondition` in the stack —
 * e.g. a function that performs out-of-band initialization and unblocks the
 * stack when done. Provide the implementation with
 * `Effect.provide(AWS.CloudFormation.SignalResourceHttp)`.
 * @binding
 * @section Signaling Resources
 * @example Signal a Wait Condition
 * ```typescript
 * const signalResource = yield* AWS.CloudFormation.SignalResource(stack);
 *
 * yield* signalResource({
 *   LogicalResourceId: "WaitCondition",
 *   UniqueId: "init-1",
 *   Status: "SUCCESS",
 * });
 * ```
 */
export interface SignalResource extends Binding.Service<
  SignalResource,
  "AWS.CloudFormation.SignalResource",
  (
    stack: Stack,
  ) => Effect.Effect<
    (
      request: Omit<cloudformation.SignalResourceInput, "StackName">,
    ) => Effect.Effect<
      cloudformation.SignalResourceResponse,
      cloudformation.SignalResourceError
    >
  >
> {}
export const SignalResource = Binding.Service<SignalResource>(
  "AWS.CloudFormation.SignalResource",
);
