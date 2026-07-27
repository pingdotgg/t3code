import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetUserProfileRequest extends Omit<
  datazone.GetUserProfileInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetUserProfile`.
 *
 * Reads a user profile in the bound domain — e.g. to resolve the requester of a subscription request. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetUserProfileHttp)`.
 * @binding
 * @section Portal, Profiles & Notifications
 * @example Resolve a User Profile
 * ```typescript
 * // init — bind the operation to the domain
 * const getUserProfile = yield* AWS.DataZone.GetUserProfile(domain);
 *
 * // runtime
 * const profile = yield* getUserProfile({ userIdentifier: userId });
 * ```
 */
export interface GetUserProfile extends Binding.Service<
  GetUserProfile,
  "AWS.DataZone.GetUserProfile",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetUserProfileRequest,
    ) => Effect.Effect<
      datazone.GetUserProfileOutput,
      datazone.GetUserProfileError
    >
  >
> {}
export const GetUserProfile = Binding.Service<GetUserProfile>(
  "AWS.DataZone.GetUserProfile",
);
