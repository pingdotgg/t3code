import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/** `ListAssociatedResources` request with `application` injected from the bound {@link Application}. */
export interface ListAssociatedResourcesRequest extends Omit<
  appregistry.ListAssociatedResourcesRequest,
  "application"
> {}

/**
 * Runtime binding for `servicecatalog:ListAssociatedResources`.
 *
 * Pages through the resources associated with the bound application.
 * Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.ListAssociatedResourcesHttp)`.
 * @binding
 * @section Reading Associated Resources
 * @example List the Application's Resources
 * ```typescript
 * // init — bind the operation to the application
 * const listAssociatedResources =
 *   yield* AWS.AppRegistry.ListAssociatedResources(app);
 *
 * // runtime
 * const page = yield* listAssociatedResources({ maxResults: 25 });
 * console.log(page.resources?.map((r) => r.arn));
 * ```
 */
export interface ListAssociatedResources extends Binding.Service<
  ListAssociatedResources,
  "AWS.AppRegistry.ListAssociatedResources",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListAssociatedResourcesRequest,
    ) => Effect.Effect<
      appregistry.ListAssociatedResourcesResponse,
      appregistry.ListAssociatedResourcesError
    >
  >
> {}

export const ListAssociatedResources = Binding.Service<ListAssociatedResources>(
  "AWS.AppRegistry.ListAssociatedResources",
);
