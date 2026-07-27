import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:AcceptAdministratorInvitation`.
 *
 * Accepts a GuardDuty administrator invitation — the member-account side of the invitation handshake.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.AcceptAdministratorInvitationHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Accept an Invitation
 * ```typescript
 * // init
 * const acceptAdministratorInvitation = yield* AWS.GuardDuty.AcceptAdministratorInvitation(detector);
 *
 * // runtime
 * yield* acceptAdministratorInvitation({
 *   AdministratorId: adminAccountId,
 *   InvitationId: invitationId,
 * });
 * ```
 */
export interface AcceptAdministratorInvitation extends Binding.Service<
  AcceptAdministratorInvitation,
  "AWS.GuardDuty.AcceptAdministratorInvitation",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<
        guardduty.AcceptAdministratorInvitationRequest,
        "DetectorId"
      >,
    ) => Effect.Effect<
      guardduty.AcceptAdministratorInvitationResponse,
      guardduty.AcceptAdministratorInvitationError
    >
  >
> {}
export const AcceptAdministratorInvitation =
  Binding.Service<AcceptAdministratorInvitation>(
    "AWS.GuardDuty.AcceptAdministratorInvitation",
  );
