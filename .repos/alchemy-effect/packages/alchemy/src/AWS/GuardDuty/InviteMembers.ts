import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:InviteMembers`.
 *
 * Invites member accounts (created via `CreateMembers`) to enable GuardDuty under this administrator.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.InviteMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Invite Members
 * ```typescript
 * // init
 * const inviteMembers = yield* AWS.GuardDuty.InviteMembers(detector);
 *
 * // runtime
 * yield* inviteMembers({
 *   AccountIds: ["111122223333"],
 *   Message: "Please enable GuardDuty",
 * });
 * ```
 */
export interface InviteMembers extends Binding.Service<
  InviteMembers,
  "AWS.GuardDuty.InviteMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.InviteMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.InviteMembersResponse,
      guardduty.InviteMembersError
    >
  >
> {}
export const InviteMembers = Binding.Service<InviteMembers>(
  "AWS.GuardDuty.InviteMembers",
);
