import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SigningProfile } from "./SigningProfile.ts";

/**
 * Runtime binding for `signer:RevokeSigningProfile`.
 *
 * Revokes a version of the bound {@link SigningProfile}, permanently
 * invalidating every signature that version produced on or after
 * `effectiveTime` — the incident-response lever when signing material is
 * compromised. Revocation is irreversible. The profile name is injected from
 * the binding; pass the `profileVersion` to revoke. Provide the
 * implementation with `Effect.provide(AWS.Signer.RevokeSigningProfileHttp)`.
 * @binding
 * @section Revoking Signatures
 * @example Revoke a Compromised Profile Version
 * ```typescript
 * // init — bind the operation to the profile
 * const revokeSigningProfile = yield* AWS.Signer.RevokeSigningProfile(profile);
 *
 * // runtime — invalidate everything the version signed from now on
 * yield* revokeSigningProfile({
 *   profileVersion,
 *   reason: "signing key compromised",
 *   effectiveTime: new Date(),
 * });
 * ```
 */
export interface RevokeSigningProfile extends Binding.Service<
  RevokeSigningProfile,
  "AWS.Signer.RevokeSigningProfile",
  (
    profile: SigningProfile,
  ) => Effect.Effect<
    (
      request: Omit<signer.RevokeSigningProfileRequest, "profileName">,
    ) => Effect.Effect<
      signer.RevokeSigningProfileResponse,
      signer.RevokeSigningProfileError
    >
  >
> {}
export const RevokeSigningProfile = Binding.Service<RevokeSigningProfile>(
  "AWS.Signer.RevokeSigningProfile",
);
