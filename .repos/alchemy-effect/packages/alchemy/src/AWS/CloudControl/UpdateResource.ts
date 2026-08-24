import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Runtime binding for `cloudformation:UpdateResource`.
 *
 * Applies an RFC 6902 JSON Patch to an existing resource's properties. The
 * call is asynchronous: poll the returned `RequestToken` with
 * {@link GetResourceRequestStatus} until the operation settles. Because Cloud
 * Control invokes the resource type's update handler with the caller's
 * credentials, pass the handler's underlying permissions via
 * {@link CloudControlBindingOptions.handlerPolicyStatements}.
 * @binding
 * @section Provisioning Resources
 * @example Patch an SSM Parameter's value
 * ```typescript
 * const updateResource = yield* CloudControl.UpdateResource({
 *   handlerPolicyStatements: [
 *     {
 *       Effect: "Allow",
 *       Action: ["ssm:PutParameter", "ssm:GetParameters"],
 *       Resource: ["*"],
 *     },
 *   ],
 * });
 *
 * // runtime
 * const updated = yield* updateResource({
 *   TypeName: "AWS::SSM::Parameter",
 *   Identifier: "/tenants/acme/greeting",
 *   PatchDocument: JSON.stringify([
 *     { op: "replace", path: "/Value", value: "howdy" },
 *   ]),
 * });
 * ```
 */
export interface UpdateResource extends Binding.Service<
  UpdateResource,
  "AWS.CloudControl.UpdateResource",
  (
    options?: CloudControlBindingOptions,
  ) => Effect.Effect<
    (
      request: cloudcontrol.UpdateResourceInput,
    ) => Effect.Effect<
      cloudcontrol.UpdateResourceOutput,
      cloudcontrol.UpdateResourceError
    >
  >
> {}

export const UpdateResource = Binding.Service<UpdateResource>(
  "AWS.CloudControl.UpdateResource",
);
