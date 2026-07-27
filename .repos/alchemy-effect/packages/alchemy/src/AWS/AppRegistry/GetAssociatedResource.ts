import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/** `GetAssociatedResource` request with `application` injected from the bound {@link Application}. */
export interface GetAssociatedResourceRequest extends Omit<
  appregistry.GetAssociatedResourceRequest,
  "application"
> {}

/**
 * Runtime binding for `servicecatalog:GetAssociatedResource`.
 *
 * Reads one resource associated with the bound application, including its
 * application-tag sync status. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.GetAssociatedResourceHttp)`.
 * @binding
 * @section Reading Associated Resources
 * @example Get an Associated CloudFormation Stack
 * ```typescript
 * // init — bind the operation to the application
 * const getAssociatedResource =
 *   yield* AWS.AppRegistry.GetAssociatedResource(app);
 *
 * // runtime
 * const result = yield* getAssociatedResource({
 *   resourceType: "CFN_STACK",
 *   resource: "my-stack",
 * });
 * console.log(result.resource?.arn);
 * ```
 */
export interface GetAssociatedResource extends Binding.Service<
  GetAssociatedResource,
  "AWS.AppRegistry.GetAssociatedResource",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetAssociatedResourceRequest,
    ) => Effect.Effect<
      appregistry.GetAssociatedResourceResponse,
      appregistry.GetAssociatedResourceError
    >
  >
> {}

export const GetAssociatedResource = Binding.Service<GetAssociatedResource>(
  "AWS.AppRegistry.GetAssociatedResource",
);
