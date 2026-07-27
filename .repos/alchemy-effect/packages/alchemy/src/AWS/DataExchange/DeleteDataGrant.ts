import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:DeleteDataGrant`.
 *
 * Deletes a sent data grant, revoking the receiver's entitlement.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.DeleteDataGrantHttp)`.
 * @binding
 * @section Data Grants
 * @example Revoke A Sent Grant
 * ```typescript
 * const deleteDataGrant = yield* AWS.DataExchange.DeleteDataGrant();
 *
 * // runtime
 * yield* deleteDataGrant({ DataGrantId: grantId });
 * ```
 */
export interface DeleteDataGrant extends Binding.Service<
  DeleteDataGrant,
  "AWS.DataExchange.DeleteDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.DeleteDataGrantRequest,
    ) => Effect.Effect<
      dataexchange.DeleteDataGrantResponse,
      dataexchange.DeleteDataGrantError
    >
  >
> {}
export const DeleteDataGrant = Binding.Service<DeleteDataGrant>(
  "AWS.DataExchange.DeleteDataGrant",
);
