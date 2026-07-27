import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/** `ListAssociatedAttributeGroups` request with `application` injected from the bound {@link Application}. */
export interface ListAssociatedAttributeGroupsRequest extends Omit<
  appregistry.ListAssociatedAttributeGroupsRequest,
  "application"
> {}

/**
 * Runtime binding for `servicecatalog:ListAssociatedAttributeGroups`.
 *
 * Pages through the IDs of the attribute groups associated with the bound
 * application. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.ListAssociatedAttributeGroupsHttp)`.
 * @binding
 * @section Reading Attribute Groups
 * @example List the Application's Attribute Group IDs
 * ```typescript
 * // init — bind the operation to the application
 * const listAssociatedAttributeGroups =
 *   yield* AWS.AppRegistry.ListAssociatedAttributeGroups(app);
 *
 * // runtime
 * const page = yield* listAssociatedAttributeGroups({ maxResults: 25 });
 * console.log(page.attributeGroups);
 * ```
 */
export interface ListAssociatedAttributeGroups extends Binding.Service<
  ListAssociatedAttributeGroups,
  "AWS.AppRegistry.ListAssociatedAttributeGroups",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListAssociatedAttributeGroupsRequest,
    ) => Effect.Effect<
      appregistry.ListAssociatedAttributeGroupsResponse,
      appregistry.ListAssociatedAttributeGroupsError
    >
  >
> {}

export const ListAssociatedAttributeGroups =
  Binding.Service<ListAssociatedAttributeGroups>(
    "AWS.AppRegistry.ListAssociatedAttributeGroups",
  );
