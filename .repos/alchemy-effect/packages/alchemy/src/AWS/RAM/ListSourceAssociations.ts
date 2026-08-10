import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListSourceAssociations`.
 *
 * Lists the source associations of your resource shares — the sources that service-managed shares draw resources from.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListSourceAssociationsHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example List Source Associations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSourceAssociations = yield* AWS.RAM.ListSourceAssociations();
 *
 * // runtime
 * const { sourceAssociations } = yield* listSourceAssociations();
 * ```
 */
export interface ListSourceAssociations extends Binding.Service<
  ListSourceAssociations,
  "AWS.RAM.ListSourceAssociations",
  () => Effect.Effect<
    (
      request?: ram.ListSourceAssociationsRequest,
    ) => Effect.Effect<
      ram.ListSourceAssociationsResponse,
      ram.ListSourceAssociationsError
    >
  >
> {}
export const ListSourceAssociations = Binding.Service<ListSourceAssociations>(
  "AWS.RAM.ListSourceAssociations",
);
