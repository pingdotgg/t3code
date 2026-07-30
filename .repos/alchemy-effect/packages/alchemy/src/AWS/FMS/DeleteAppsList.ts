import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteAppsList}.
 */
export interface DeleteAppsListRequest extends fms.DeleteAppsListRequest {}

/**
 * Runtime binding for `fms:DeleteAppsList`.
 *
 * Permanently deletes the specified Firewall Manager applications list. Provide the
 * implementation with `Effect.provide(AWS.FMS.DeleteAppsListHttp)`.
 * @binding
 * @section Applications Lists
 * @example Delete an Applications List
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteAppsList = yield* AWS.FMS.DeleteAppsList();
 *
 * // runtime
 * yield* deleteAppsList({ ListId: listId });
 * ```
 */
export interface DeleteAppsList extends Binding.Service<
  DeleteAppsList,
  "AWS.FMS.DeleteAppsList",
  () => Effect.Effect<
    (
      request: DeleteAppsListRequest,
    ) => Effect.Effect<fms.DeleteAppsListResponse, fms.DeleteAppsListError>
  >
> {}

export const DeleteAppsList = Binding.Service<DeleteAppsList>(
  "AWS.FMS.DeleteAppsList",
);
