import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CloudControlBindingOptions } from "./BindingOptions.ts";

/**
 * Runtime binding for `cloudformation:ListResources`.
 *
 * Discovers resources of a given CloudFormation type in the account and
 * Region — whether or not they were provisioned through Cloud Control.
 * Because Cloud Control invokes the resource type's list handler with the
 * caller's credentials, pass the handler's underlying permissions via
 * {@link CloudControlBindingOptions.handlerPolicyStatements}.
 * @binding
 * @section Reading Resources
 * @example List SSM Parameters
 * ```typescript
 * // init — account-level; grant the list handler's permissions too
 * const listResources = yield* CloudControl.ListResources({
 *   handlerPolicyStatements: [
 *     { Effect: "Allow", Action: ["ssm:DescribeParameters"], Resource: ["*"] },
 *   ],
 * });
 *
 * // runtime
 * const page = yield* listResources({
 *   TypeName: "AWS::SSM::Parameter",
 *   MaxResults: 100,
 * });
 * const identifiers = (page.ResourceDescriptions ?? []).map((r) => r.Identifier);
 * ```
 */
export interface ListResources extends Binding.Service<
  ListResources,
  "AWS.CloudControl.ListResources",
  (
    options?: CloudControlBindingOptions,
  ) => Effect.Effect<
    (
      request: cloudcontrol.ListResourcesInput,
    ) => Effect.Effect<
      cloudcontrol.ListResourcesOutput,
      cloudcontrol.ListResourcesError
    >
  >
> {}

export const ListResources = Binding.Service<ListResources>(
  "AWS.CloudControl.ListResources",
);
