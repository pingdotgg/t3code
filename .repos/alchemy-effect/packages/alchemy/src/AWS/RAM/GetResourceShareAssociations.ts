import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:GetResourceShareAssociations`.
 *
 * Retrieves the principal and resource associations of your resource shares — who has access, and to what.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.GetResourceShareAssociationsHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example List the Principals Associated with Your Shares
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getResourceShareAssociations = yield* AWS.RAM.GetResourceShareAssociations();
 *
 * // runtime
 * const { resourceShareAssociations } =
 *   yield* getResourceShareAssociations({ associationType: "PRINCIPAL" });
 * ```
 */
export interface GetResourceShareAssociations extends Binding.Service<
  GetResourceShareAssociations,
  "AWS.RAM.GetResourceShareAssociations",
  () => Effect.Effect<
    (
      request: ram.GetResourceShareAssociationsRequest,
    ) => Effect.Effect<
      ram.GetResourceShareAssociationsResponse,
      ram.GetResourceShareAssociationsError
    >
  >
> {}
export const GetResourceShareAssociations =
  Binding.Service<GetResourceShareAssociations>(
    "AWS.RAM.GetResourceShareAssociations",
  );
