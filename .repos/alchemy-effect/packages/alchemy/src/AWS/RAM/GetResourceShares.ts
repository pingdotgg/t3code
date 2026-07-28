import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:GetResourceShares`.
 *
 * Retrieves details about the resource shares that you own (`resourceOwner: "SELF"`) or that are shared with you (`resourceOwner: "OTHER-ACCOUNTS"`).
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.GetResourceSharesHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example List the Resource Shares You Own
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getResourceShares = yield* AWS.RAM.GetResourceShares();
 *
 * // runtime
 * const { resourceShares } = yield* getResourceShares({
 *   resourceOwner: "SELF",
 * });
 * ```
 */
export interface GetResourceShares extends Binding.Service<
  GetResourceShares,
  "AWS.RAM.GetResourceShares",
  () => Effect.Effect<
    (
      request: ram.GetResourceSharesRequest,
    ) => Effect.Effect<
      ram.GetResourceSharesResponse,
      ram.GetResourceSharesError
    >
  >
> {}
export const GetResourceShares = Binding.Service<GetResourceShares>(
  "AWS.RAM.GetResourceShares",
);
