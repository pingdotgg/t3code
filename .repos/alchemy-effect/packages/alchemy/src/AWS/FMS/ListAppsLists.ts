import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListAppsLists}.
 */
export interface ListAppsListsRequest extends fms.ListAppsListsRequest {}

/**
 * Runtime binding for `fms:ListAppsLists`.
 *
 * Returns an array of `AppsListDataSummary` objects for the applications lists in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListAppsListsHttp)`.
 * @binding
 * @section Applications Lists
 * @example List Applications Lists
 * ```typescript
 * // init — account-level binding takes no resource
 * const listAppsLists = yield* AWS.FMS.ListAppsLists();
 *
 * // runtime
 * const result = yield* listAppsLists({ MaxResults: 25 });
 * console.log(result.AppsLists?.length);
 * ```
 */
export interface ListAppsLists extends Binding.Service<
  ListAppsLists,
  "AWS.FMS.ListAppsLists",
  () => Effect.Effect<
    (
      request: ListAppsListsRequest,
    ) => Effect.Effect<fms.ListAppsListsResponse, fms.ListAppsListsError>
  >
> {}

export const ListAppsLists = Binding.Service<ListAppsLists>(
  "AWS.FMS.ListAppsLists",
);
