import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetProtocolsList}.
 */
export interface GetProtocolsListRequest extends fms.GetProtocolsListRequest {}

/**
 * Runtime binding for `fms:GetProtocolsList`.
 *
 * Returns the specified Firewall Manager protocols list. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetProtocolsListHttp)`.
 * @binding
 * @section Protocols Lists
 * @example Read a Protocols List
 * ```typescript
 * // init — account-level binding takes no resource
 * const getProtocolsList = yield* AWS.FMS.GetProtocolsList();
 *
 * // runtime
 * const result = yield* getProtocolsList({ ListId: listId });
 * console.log(result.ProtocolsList?.ProtocolsList);
 * ```
 */
export interface GetProtocolsList extends Binding.Service<
  GetProtocolsList,
  "AWS.FMS.GetProtocolsList",
  () => Effect.Effect<
    (
      request: GetProtocolsListRequest,
    ) => Effect.Effect<fms.GetProtocolsListResponse, fms.GetProtocolsListError>
  >
> {}

export const GetProtocolsList = Binding.Service<GetProtocolsList>(
  "AWS.FMS.GetProtocolsList",
);
