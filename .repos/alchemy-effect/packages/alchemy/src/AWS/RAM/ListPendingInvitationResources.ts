import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListPendingInvitationResources`.
 *
 * Lists the resources inside a resource share whose invitation to you is still pending.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListPendingInvitationResourcesHttp)`.
 * @binding
 * @section Invitations
 * @example Inspect an Invitation Before Accepting
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPendingInvitationResources = yield* AWS.RAM.ListPendingInvitationResources();
 *
 * // runtime
 * const { resources } = yield* listPendingInvitationResources({
 *   resourceShareInvitationArn: invitationArn,
 * });
 * ```
 */
export interface ListPendingInvitationResources extends Binding.Service<
  ListPendingInvitationResources,
  "AWS.RAM.ListPendingInvitationResources",
  () => Effect.Effect<
    (
      request: ram.ListPendingInvitationResourcesRequest,
    ) => Effect.Effect<
      ram.ListPendingInvitationResourcesResponse,
      ram.ListPendingInvitationResourcesError
    >
  >
> {}
export const ListPendingInvitationResources =
  Binding.Service<ListPendingInvitationResources>(
    "AWS.RAM.ListPendingInvitationResources",
  );
