import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:RevokeSignature`.
 *
 * Permanently invalidates the signature produced by a single signing job —
 * the surgical alternative to revoking a whole profile version when one
 * artifact is compromised. Account-level operation — job ids are chosen per
 * request at runtime, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Signer.RevokeSignatureHttp)`.
 * @binding
 * @section Revoking Signatures
 * @example Revoke One Job's Signature
 * ```typescript
 * // init — account-level binding, no resource argument
 * const revokeSignature = yield* AWS.Signer.RevokeSignature();
 *
 * // runtime
 * yield* revokeSignature({ jobId, reason: "artifact compromised" });
 * ```
 */
export interface RevokeSignature extends Binding.Service<
  RevokeSignature,
  "AWS.Signer.RevokeSignature",
  () => Effect.Effect<
    (
      request: signer.RevokeSignatureRequest,
    ) => Effect.Effect<
      signer.RevokeSignatureResponse,
      signer.RevokeSignatureError
    >
  >
> {}
export const RevokeSignature = Binding.Service<RevokeSignature>(
  "AWS.Signer.RevokeSignature",
);
