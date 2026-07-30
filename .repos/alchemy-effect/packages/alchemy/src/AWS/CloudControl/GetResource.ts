import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Runtime binding for `cloudformation:GetResource`.
 *
 * Reads the current state of any Cloud Control-supported resource — whether
 * or not it was provisioned through Cloud Control. Because Cloud Control
 * invokes the resource type's read handler with the caller's credentials,
 * pass the handler's underlying permissions via
 * {@link CloudControlBindingOptions.handlerPolicyStatements}.
 * @binding
 * @section Reading Resources
 * @example Read an SSM Parameter's live state
 * ```typescript
 * // init — account-level; grant the read handler's permissions too
 * const getResource = yield* CloudControl.GetResource({
 *   handlerPolicyStatements: [
 *     { Effect: "Allow", Action: ["ssm:GetParameters"], Resource: ["*"] },
 *   ],
 * });
 *
 * // runtime
 * const result = yield* getResource({
 *   TypeName: "AWS::SSM::Parameter",
 *   Identifier: "/app/greeting",
 * });
 * ```
 */
export interface GetResource extends Binding.Service<
  GetResource,
  "AWS.CloudControl.GetResource",
  (
    options?: CloudControlBindingOptions,
  ) => Effect.Effect<
    (
      request: cloudcontrol.GetResourceInput,
    ) => Effect.Effect<
      cloudcontrol.GetResourceOutput,
      cloudcontrol.GetResourceError
    >
  >
> {}

export const GetResource = Binding.Service<GetResource>(
  "AWS.CloudControl.GetResource",
);
