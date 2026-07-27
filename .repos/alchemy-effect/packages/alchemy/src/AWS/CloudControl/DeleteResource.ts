import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Runtime binding for `cloudformation:DeleteResource`.
 *
 * Deletes a Cloud Control-supported resource. The call is asynchronous: poll
 * the returned `RequestToken` with {@link GetResourceRequestStatus} until the
 * operation settles. Because Cloud Control invokes the resource type's delete
 * handler with the caller's credentials, pass the handler's underlying
 * permissions via
 * {@link CloudControlBindingOptions.handlerPolicyStatements}.
 * @binding
 * @section Provisioning Resources
 * @example Delete an SSM Parameter at runtime
 * ```typescript
 * const deleteResource = yield* CloudControl.DeleteResource({
 *   handlerPolicyStatements: [
 *     { Effect: "Allow", Action: ["ssm:DeleteParameter"], Resource: ["*"] },
 *   ],
 * });
 *
 * // runtime
 * const deleted = yield* deleteResource({
 *   TypeName: "AWS::SSM::Parameter",
 *   Identifier: "/tenants/acme/greeting",
 * });
 * ```
 */
export interface DeleteResource extends Binding.Service<
  DeleteResource,
  "AWS.CloudControl.DeleteResource",
  (
    options?: CloudControlBindingOptions,
  ) => Effect.Effect<
    (
      request: cloudcontrol.DeleteResourceInput,
    ) => Effect.Effect<
      cloudcontrol.DeleteResourceOutput,
      cloudcontrol.DeleteResourceError
    >
  >
> {}

export const DeleteResource = Binding.Service<DeleteResource>(
  "AWS.CloudControl.DeleteResource",
);
