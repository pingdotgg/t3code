import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SigningProfile } from "./SigningProfile.ts";

/**
 * Runtime binding for `signer:SignPayload`.
 *
 * Signs a binary payload synchronously with the bound {@link SigningProfile}
 * and returns the signature inline — the API behind Notation container-image
 * signing (use a `Notation-OCI-SHA384-ECDSA` profile). The profile name is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Signer.SignPayloadHttp)`.
 * @binding
 * @section Signing Code
 * @example Sign a Notation Payload
 * ```typescript
 * // init — bind the operation to the Notation profile
 * const signPayload = yield* AWS.Signer.SignPayload(profile);
 *
 * // runtime
 * const { jobId, signature } = yield* signPayload({
 *   payload: new TextEncoder().encode(JSON.stringify(notaryPayload)),
 *   payloadFormat: "application/vnd.cncf.notary.payload.v1+json",
 * });
 * ```
 */
export interface SignPayload extends Binding.Service<
  SignPayload,
  "AWS.Signer.SignPayload",
  (
    profile: SigningProfile,
  ) => Effect.Effect<
    (
      request: Omit<signer.SignPayloadRequest, "profileName">,
    ) => Effect.Effect<signer.SignPayloadResponse, signer.SignPayloadError>
  >
> {}
export const SignPayload = Binding.Service<SignPayload>(
  "AWS.Signer.SignPayload",
);
