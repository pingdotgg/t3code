import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteProtocolsList}.
 */
export interface DeleteProtocolsListRequest
  extends fms.DeleteProtocolsListRequest {}

/**
 * Runtime binding for `fms:DeleteProtocolsList`.
 *
 * Permanently deletes the specified Firewall Manager protocols list. Provide the
 * implementation with `Effect.provide(AWS.FMS.DeleteProtocolsListHttp)`.
 * @binding
 * @section Protocols Lists
 * @example Delete a Protocols List
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteProtocolsList = yield* AWS.FMS.DeleteProtocolsList();
 *
 * // runtime
 * yield* deleteProtocolsList({ ListId: listId });
 * ```
 */
export interface DeleteProtocolsList extends Binding.Service<
  DeleteProtocolsList,
  "AWS.FMS.DeleteProtocolsList",
  () => Effect.Effect<
    (
      request: DeleteProtocolsListRequest,
    ) => Effect.Effect<
      fms.DeleteProtocolsListResponse,
      fms.DeleteProtocolsListError
    >
  >
> {}

export const DeleteProtocolsList = Binding.Service<DeleteProtocolsList>(
  "AWS.FMS.DeleteProtocolsList",
);
