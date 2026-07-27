import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:GetDataGrant`.
 *
 * Reads a sent data grant's detail — receiver, acceptance state, and
 * expiration.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetDataGrantHttp)`.
 * @binding
 * @section Data Grants
 * @example Check A Grant's Acceptance State
 * ```typescript
 * const getDataGrant = yield* AWS.DataExchange.GetDataGrant();
 *
 * // runtime
 * const grant = yield* getDataGrant({ DataGrantId: grantId });
 * yield* Effect.log(`state: ${grant.AcceptanceState}`);
 * ```
 */
export interface GetDataGrant extends Binding.Service<
  GetDataGrant,
  "AWS.DataExchange.GetDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.GetDataGrantRequest,
    ) => Effect.Effect<
      dataexchange.GetDataGrantResponse,
      dataexchange.GetDataGrantError
    >
  >
> {}
export const GetDataGrant = Binding.Service<GetDataGrant>(
  "AWS.DataExchange.GetDataGrant",
);
