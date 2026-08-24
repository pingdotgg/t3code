import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:DeleteSuppressedDestination`.
 *
 * Removes an email address from the account-level suppression list — e.g.
 * after a recipient re-subscribes or a bounce is resolved. Fails with the
 * typed `NotFoundException` tag when the address is not on the list.
 * Account-level operation. Provide the implementation with
 * `Effect.provide(AWS.SES.DeleteSuppressedDestinationHttp)`.
 * @binding
 * @section Suppression List
 * @example Unsuppress an Address
 * ```typescript
 * // init — account-level binding, no resource argument
 * const unsuppress = yield* SES.DeleteSuppressedDestination();
 *
 * // runtime
 * yield* unsuppress({ EmailAddress: "resubscribed@example.com" }).pipe(
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteSuppressedDestination extends Binding.Service<
  DeleteSuppressedDestination,
  "AWS.SES.DeleteSuppressedDestination",
  () => Effect.Effect<
    (
      request: sesv2.DeleteSuppressedDestinationRequest,
    ) => Effect.Effect<
      sesv2.DeleteSuppressedDestinationResponse,
      sesv2.DeleteSuppressedDestinationError
    >
  >
> {}
export const DeleteSuppressedDestination =
  Binding.Service<DeleteSuppressedDestination>(
    "AWS.SES.DeleteSuppressedDestination",
  );
