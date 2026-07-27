import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:CancelHandshake`.
 *
 * Cancels a pending handshake from the originator side — e.g. withdrawing an invitation before the recipient responds.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.CancelHandshakeHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example Withdraw an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const cancelHandshake = yield* AWS.Organizations.CancelHandshake();
 *
 * // runtime
 * const { Handshake } = yield* cancelHandshake({ HandshakeId: handshakeId });
 * ```
 */
export interface CancelHandshake extends Binding.Service<
  CancelHandshake,
  "AWS.Organizations.CancelHandshake",
  () => Effect.Effect<
    (
      request: organizations.CancelHandshakeRequest,
    ) => Effect.Effect<
      organizations.CancelHandshakeResponse,
      organizations.CancelHandshakeError
    >
  >
> {}
export const CancelHandshake = Binding.Service<CancelHandshake>(
  "AWS.Organizations.CancelHandshake",
);
