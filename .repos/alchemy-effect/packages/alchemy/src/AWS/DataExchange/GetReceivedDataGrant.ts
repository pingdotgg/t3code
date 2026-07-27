import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:GetReceivedDataGrant`.
 *
 * Reads a received data grant's detail — sender, acceptance state, and
 * expiration.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetReceivedDataGrantHttp)`.
 * @binding
 * @section Data Grants
 * @example Inspect A Received Grant
 * ```typescript
 * const getReceivedDataGrant =
 *   yield* AWS.DataExchange.GetReceivedDataGrant();
 *
 * // runtime
 * const grant = yield* getReceivedDataGrant({ DataGrantArn: grantArn });
 * ```
 */
export interface GetReceivedDataGrant extends Binding.Service<
  GetReceivedDataGrant,
  "AWS.DataExchange.GetReceivedDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.GetReceivedDataGrantRequest,
    ) => Effect.Effect<
      dataexchange.GetReceivedDataGrantResponse,
      dataexchange.GetReceivedDataGrantError
    >
  >
> {}
export const GetReceivedDataGrant = Binding.Service<GetReceivedDataGrant>(
  "AWS.DataExchange.GetReceivedDataGrant",
);
