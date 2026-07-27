import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:AcceptHandshake`.
 *
 * Accepts a pending handshake — e.g. an invitation to join an organization, called from the invited member account.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.AcceptHandshakeHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example Accept an Invitation
 * ```typescript
 * // init — account-level binding, no resource argument
 * const acceptHandshake = yield* AWS.Organizations.AcceptHandshake();
 *
 * // runtime
 * const { Handshake } = yield* acceptHandshake({ HandshakeId: handshakeId });
 * ```
 */
export interface AcceptHandshake extends Binding.Service<
  AcceptHandshake,
  "AWS.Organizations.AcceptHandshake",
  () => Effect.Effect<
    (
      request: organizations.AcceptHandshakeRequest,
    ) => Effect.Effect<
      organizations.AcceptHandshakeResponse,
      organizations.AcceptHandshakeError
    >
  >
> {}
export const AcceptHandshake = Binding.Service<AcceptHandshake>(
  "AWS.Organizations.AcceptHandshake",
);
