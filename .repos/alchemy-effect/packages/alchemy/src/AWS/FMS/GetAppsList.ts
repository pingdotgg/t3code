import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetAppsList}.
 */
export interface GetAppsListRequest extends fms.GetAppsListRequest {}

/**
 * Runtime binding for `fms:GetAppsList`.
 *
 * Returns the specified Firewall Manager applications list. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetAppsListHttp)`.
 * @binding
 * @section Applications Lists
 * @example Read an Applications List
 * ```typescript
 * // init — account-level binding takes no resource
 * const getAppsList = yield* AWS.FMS.GetAppsList();
 *
 * // runtime
 * const result = yield* getAppsList({ ListId: listId });
 * console.log(result.AppsList?.AppsList?.length);
 * ```
 */
export interface GetAppsList extends Binding.Service<
  GetAppsList,
  "AWS.FMS.GetAppsList",
  () => Effect.Effect<
    (
      request: GetAppsListRequest,
    ) => Effect.Effect<fms.GetAppsListResponse, fms.GetAppsListError>
  >
> {}

export const GetAppsList = Binding.Service<GetAppsList>("AWS.FMS.GetAppsList");
