import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Runtime binding for `cloudformation:CreateResource`.
 *
 * Provisions any Cloud Control-supported resource from inside a Function —
 * the building block for dynamic, per-tenant provisioning services. The call
 * is asynchronous: poll the returned `RequestToken` with
 * {@link GetResourceRequestStatus} until the operation settles. Because Cloud
 * Control invokes the resource type's create handler with the caller's
 * credentials, pass the handler's underlying permissions via
 * {@link CloudControlBindingOptions.handlerPolicyStatements}.
 * @binding
 * @section Provisioning Resources
 * @example Create an SSM Parameter at runtime
 * ```typescript
 * // init — account-level; grant the create handler's permissions too
 * const createResource = yield* CloudControl.CreateResource({
 *   handlerPolicyStatements: [
 *     {
 *       Effect: "Allow",
 *       Action: ["ssm:PutParameter", "ssm:GetParameters", "ssm:AddTagsToResource"],
 *       Resource: ["*"],
 *     },
 *   ],
 * });
 *
 * // runtime
 * const created = yield* createResource({
 *   TypeName: "AWS::SSM::Parameter",
 *   DesiredState: JSON.stringify({
 *     Name: "/tenants/acme/greeting",
 *     Type: "String",
 *     Value: "hello",
 *   }),
 * });
 * // poll created.ProgressEvent.RequestToken until SUCCESS
 * ```
 */
export interface CreateResource extends Binding.Service<
  CreateResource,
  "AWS.CloudControl.CreateResource",
  (
    options?: CloudControlBindingOptions,
  ) => Effect.Effect<
    (
      request: cloudcontrol.CreateResourceInput,
    ) => Effect.Effect<
      cloudcontrol.CreateResourceOutput,
      cloudcontrol.CreateResourceError
    >
  >
> {}

export const CreateResource = Binding.Service<CreateResource>(
  "AWS.CloudControl.CreateResource",
);
