import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:GetSuppressedDestination`.
 *
 * Retrieves a specific address from the account-level suppression list —
 * check whether (and why) an address is suppressed before attempting a
 * send. Fails with the typed `NotFoundException` tag when the address is
 * not on the list. Account-level operation. Provide the implementation with
 * `Effect.provide(AWS.SES.GetSuppressedDestinationHttp)`.
 * @binding
 * @section Suppression List
 * @example Look Up a Suppressed Address
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSuppressed = yield* SES.GetSuppressedDestination();
 *
 * // runtime
 * const { SuppressedDestination } = yield* getSuppressed({
 *   EmailAddress: "bouncing@example.com",
 * });
 * // SuppressedDestination.Reason — "BOUNCE" | "COMPLAINT"
 * ```
 */
export interface GetSuppressedDestination extends Binding.Service<
  GetSuppressedDestination,
  "AWS.SES.GetSuppressedDestination",
  () => Effect.Effect<
    (
      request: sesv2.GetSuppressedDestinationRequest,
    ) => Effect.Effect<
      sesv2.GetSuppressedDestinationResponse,
      sesv2.GetSuppressedDestinationError
    >
  >
> {}
export const GetSuppressedDestination =
  Binding.Service<GetSuppressedDestination>("AWS.SES.GetSuppressedDestination");
