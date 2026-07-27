import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ListApplications`.
 *
 * Enumerates all AppRegistry applications in the account — useful in
 * discovery/dashboard functions that inventory registered applications.
 * Account-level: no resource argument. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.ListApplicationsHttp)`.
 * @binding
 * @section Discovering Applications
 * @example List the Account's Applications
 * ```typescript
 * // init — account-level, no resource argument
 * const listApplications = yield* AWS.AppRegistry.ListApplications();
 *
 * // runtime
 * const page = yield* listApplications({ maxResults: 20 });
 * for (const app of page.applications ?? []) {
 *   console.log(app.name, app.id);
 * }
 * ```
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "AWS.AppRegistry.ListApplications",
  () => Effect.Effect<
    (
      request?: appregistry.ListApplicationsRequest,
    ) => Effect.Effect<
      appregistry.ListApplicationsResponse,
      appregistry.ListApplicationsError
    >
  >
> {}

export const ListApplications = Binding.Service<ListApplications>(
  "AWS.AppRegistry.ListApplications",
);
