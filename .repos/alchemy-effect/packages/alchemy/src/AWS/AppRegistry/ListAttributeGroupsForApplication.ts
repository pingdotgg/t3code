import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/** `ListAttributeGroupsForApplication` request with `application` injected from the bound {@link Application}. */
export interface ListAttributeGroupsForApplicationRequest extends Omit<
  appregistry.ListAttributeGroupsForApplicationRequest,
  "application"
> {}

/**
 * Runtime binding for `servicecatalog:ListAttributeGroupsForApplication`.
 *
 * Pages through the details (ID, ARN, name) of the attribute groups
 * associated with the bound application. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.ListAttributeGroupsForApplicationHttp)`.
 * @binding
 * @section Reading Attribute Groups
 * @example List the Application's Attribute Group Details
 * ```typescript
 * // init — bind the operation to the application
 * const listAttributeGroupsForApplication =
 *   yield* AWS.AppRegistry.ListAttributeGroupsForApplication(app);
 *
 * // runtime
 * const page = yield* listAttributeGroupsForApplication({ maxResults: 25 });
 * console.log(page.attributeGroupsDetails?.map((g) => g.name));
 * ```
 */
export interface ListAttributeGroupsForApplication extends Binding.Service<
  ListAttributeGroupsForApplication,
  "AWS.AppRegistry.ListAttributeGroupsForApplication",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListAttributeGroupsForApplicationRequest,
    ) => Effect.Effect<
      appregistry.ListAttributeGroupsForApplicationResponse,
      appregistry.ListAttributeGroupsForApplicationError
    >
  >
> {}

export const ListAttributeGroupsForApplication =
  Binding.Service<ListAttributeGroupsForApplication>(
    "AWS.AppRegistry.ListAttributeGroupsForApplication",
  );
