import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link PutAppsList}.
 */
export interface PutAppsListRequest extends fms.PutAppsListRequest {}

/**
 * Runtime binding for `fms:PutAppsList`.
 *
 * Creates or updates a Firewall Manager applications list. Provide the
 * implementation with `Effect.provide(AWS.FMS.PutAppsListHttp)`.
 * @binding
 * @section Applications Lists
 * @example Create an Applications List
 * ```typescript
 * // init — account-level binding takes no resource
 * const putAppsList = yield* AWS.FMS.PutAppsList();
 *
 * // runtime
 * const result = yield* putAppsList({
 *   AppsList: {
 *     ListName: "allowed-apps",
 *     AppsList: [{ AppName: "web", Protocol: "TCP", Port: 443 }],
 *   },
 * });
 * console.log(result.AppsList?.ListId);
 * ```
 */
export interface PutAppsList extends Binding.Service<
  PutAppsList,
  "AWS.FMS.PutAppsList",
  () => Effect.Effect<
    (
      request: PutAppsListRequest,
    ) => Effect.Effect<fms.PutAppsListResponse, fms.PutAppsListError>
  >
> {}

export const PutAppsList = Binding.Service<PutAppsList>("AWS.FMS.PutAppsList");
