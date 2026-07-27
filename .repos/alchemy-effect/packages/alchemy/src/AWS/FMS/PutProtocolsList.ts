import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link PutProtocolsList}.
 */
export interface PutProtocolsListRequest extends fms.PutProtocolsListRequest {}

/**
 * Runtime binding for `fms:PutProtocolsList`.
 *
 * Creates or updates a Firewall Manager protocols list. Provide the
 * implementation with `Effect.provide(AWS.FMS.PutProtocolsListHttp)`.
 * @binding
 * @section Protocols Lists
 * @example Create a Protocols List
 * ```typescript
 * // init — account-level binding takes no resource
 * const putProtocolsList = yield* AWS.FMS.PutProtocolsList();
 *
 * // runtime
 * const result = yield* putProtocolsList({
 *   ProtocolsList: { ListName: "allowed-protocols", ProtocolsList: ["TCP", "UDP"] },
 * });
 * console.log(result.ProtocolsList?.ListId);
 * ```
 */
export interface PutProtocolsList extends Binding.Service<
  PutProtocolsList,
  "AWS.FMS.PutProtocolsList",
  () => Effect.Effect<
    (
      request: PutProtocolsListRequest,
    ) => Effect.Effect<fms.PutProtocolsListResponse, fms.PutProtocolsListError>
  >
> {}

export const PutProtocolsList = Binding.Service<PutProtocolsList>(
  "AWS.FMS.PutProtocolsList",
);
