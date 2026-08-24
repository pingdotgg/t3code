import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:AcceptDataGrant`.
 *
 * Accepts a data grant another account sent to this account, creating
 * an entitled copy of the granted data set — the receiver-side
 * automation of direct data sharing.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.AcceptDataGrantHttp)`.
 * @binding
 * @section Data Grants
 * @example Accept An Incoming Grant
 * ```typescript
 * const acceptDataGrant = yield* AWS.DataExchange.AcceptDataGrant();
 *
 * // runtime
 * const accepted = yield* acceptDataGrant({ DataGrantArn: grantArn });
 * yield* Effect.log(`entitled data set: ${accepted.DataSetId}`);
 * ```
 */
export interface AcceptDataGrant extends Binding.Service<
  AcceptDataGrant,
  "AWS.DataExchange.AcceptDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.AcceptDataGrantRequest,
    ) => Effect.Effect<
      dataexchange.AcceptDataGrantResponse,
      dataexchange.AcceptDataGrantError
    >
  >
> {}
export const AcceptDataGrant = Binding.Service<AcceptDataGrant>(
  "AWS.DataExchange.AcceptDataGrant",
);
