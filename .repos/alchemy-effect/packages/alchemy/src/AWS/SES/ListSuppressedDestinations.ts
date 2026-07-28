import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:ListSuppressedDestinations`.
 *
 * Lists the addresses on the account-level suppression list, optionally
 * filtered by reason and date range. Account-level operation. Provide the
 * implementation with
 * `Effect.provide(AWS.SES.ListSuppressedDestinationsHttp)`.
 * @binding
 * @section Suppression List
 * @example List Bounce-Suppressed Addresses
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSuppressed = yield* SES.ListSuppressedDestinations();
 *
 * // runtime
 * const { SuppressedDestinationSummaries } = yield* listSuppressed({
 *   Reasons: ["BOUNCE"],
 * });
 * ```
 */
export interface ListSuppressedDestinations extends Binding.Service<
  ListSuppressedDestinations,
  "AWS.SES.ListSuppressedDestinations",
  () => Effect.Effect<
    (
      request?: sesv2.ListSuppressedDestinationsRequest,
    ) => Effect.Effect<
      sesv2.ListSuppressedDestinationsResponse,
      sesv2.ListSuppressedDestinationsError
    >
  >
> {}
export const ListSuppressedDestinations =
  Binding.Service<ListSuppressedDestinations>(
    "AWS.SES.ListSuppressedDestinations",
  );
