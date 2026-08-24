import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:DeclineHandshake`.
 *
 * Declines a pending handshake, ending the invitation from the recipient side; the originator can no longer act on it.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DeclineHandshakeHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example Decline an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const declineHandshake = yield* AWS.Organizations.DeclineHandshake();
 *
 * // runtime
 * const { Handshake } = yield* declineHandshake({ HandshakeId: handshakeId });
 * ```
 */
export interface DeclineHandshake extends Binding.Service<
  DeclineHandshake,
  "AWS.Organizations.DeclineHandshake",
  () => Effect.Effect<
    (
      request: organizations.DeclineHandshakeRequest,
    ) => Effect.Effect<
      organizations.DeclineHandshakeResponse,
      organizations.DeclineHandshakeError
    >
  >
> {}
export const DeclineHandshake = Binding.Service<DeclineHandshake>(
  "AWS.Organizations.DeclineHandshake",
);
