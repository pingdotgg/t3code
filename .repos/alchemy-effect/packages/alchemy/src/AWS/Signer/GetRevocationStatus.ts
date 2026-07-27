import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:GetRevocationStatus`.
 *
 * Checks whether a signature's signing profile version, signing job, or
 * signing certificates have been revoked — the verification-time complement
 * to `RevokeSignature` / `RevokeSigningProfile`, served from Signer's
 * regional verification (`data-`) endpoint. Account-level operation — the
 * entities checked are chosen per request at runtime, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.Signer.GetRevocationStatusHttp)`.
 * @binding
 * @section Revoking Signatures
 * @example Verify a Signature Before Trusting It
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getRevocationStatus = yield* AWS.Signer.GetRevocationStatus();
 *
 * // runtime
 * const { revokedEntities } = yield* getRevocationStatus({
 *   signatureTimestamp: signedAt,
 *   platformId: "Notation-OCI-SHA384-ECDSA",
 *   profileVersionArn,
 *   jobArn,
 *   certificateHashes,
 * });
 * const trusted = (revokedEntities ?? []).length === 0;
 * ```
 */
export interface GetRevocationStatus extends Binding.Service<
  GetRevocationStatus,
  "AWS.Signer.GetRevocationStatus",
  () => Effect.Effect<
    (
      request: signer.GetRevocationStatusRequest,
    ) => Effect.Effect<
      signer.GetRevocationStatusResponse,
      signer.GetRevocationStatusError
    >
  >
> {}
export const GetRevocationStatus = Binding.Service<GetRevocationStatus>(
  "AWS.Signer.GetRevocationStatus",
);
