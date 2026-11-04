import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `dataexchange:DeleteDataGrant`.
 *
 * Deletes a sent data grant, revoking the receiver's entitlement.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.DeleteDataGrantHttp)`.
 * ### Data Grants
 * **Example:** Revoke A Sent Grant
 * ```typescript
 * const deleteDataGrant = yield* AWS.DataExchange.DeleteDataGrant();
 *
 * // runtime
 * yield* deleteDataGrant({ DataGrantId: grantId });
 * ```
 *
 * @binding
 */
export interface DeleteDataGrant extends Binding.Service<
  DeleteDataGrant,
  "AWS.DataExchange.DeleteDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.DeleteDataGrantRequest,
    ) => Effect.Effect<dataexchange.DeleteDataGrantResponse, dataexchange.DeleteDataGrantError>
  >
> {}
export const DeleteDataGrant = Binding.Service<DeleteDataGrant>("AWS.DataExchange.DeleteDataGrant");
