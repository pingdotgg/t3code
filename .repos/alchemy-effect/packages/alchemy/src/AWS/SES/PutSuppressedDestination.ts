import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:PutSuppressedDestination`.
 *
 * Adds an email address to the account-level suppression list — the
 * data-plane half of bounce/complaint handling: consume feedback events and
 * suppress the offending address so SES never attempts it again.
 * Account-level operation. Provide the implementation with
 * `Effect.provide(AWS.SES.PutSuppressedDestinationHttp)`.
 * @binding
 * @section Suppression List
 * @example Suppress a Hard-Bouncing Address
 * ```typescript
 * // init — account-level binding, no resource argument
 * const suppress = yield* SES.PutSuppressedDestination();
 *
 * // runtime
 * yield* suppress({
 *   EmailAddress: "bouncing@example.com",
 *   Reason: "BOUNCE",
 * });
 * ```
 */
export interface PutSuppressedDestination extends Binding.Service<
  PutSuppressedDestination,
  "AWS.SES.PutSuppressedDestination",
  () => Effect.Effect<
    (
      request: sesv2.PutSuppressedDestinationRequest,
    ) => Effect.Effect<
      sesv2.PutSuppressedDestinationResponse,
      sesv2.PutSuppressedDestinationError
    >
  >
> {}
export const PutSuppressedDestination =
  Binding.Service<PutSuppressedDestination>("AWS.SES.PutSuppressedDestination");
