import type * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Attestor } from "./Attestor.ts";

export interface ValidateAttestationRequest extends Omit<
  binaryauthorization.ValidateAttestationOccurrenceRequest,
  never
> {}

/**
 * Runtime binding for Binary Authorization
 * `attestors.validateAttestationOccurrence`.
 *
 * Bind this operation to an {@link Attestor} in a Function/Action init
 * phase. Provide {@link ValidateAttestationHttp}.
 *
 * ### Validating an Attestation
 * **Example:** Check a payload against the bound attestor
 * ```typescript
 * const validate = yield* GCP.BinaryAuthorization.ValidateAttestation(
 *   attestor,
 * );
 * const result = yield* validate({
 *   occurrenceNote: note.name,
 *   occurrenceResourceUri: imageUri,
 *   attestation: {
 *     serializedPayload: btoa("payload"),
 *     signatures: [{ publicKeyId: keyId, signature: btoa("sig") }],
 *   },
 * });
 * ```
 *
 * @binding
 * @category BinaryAuthorization
 */
export interface ValidateAttestation extends Binding.Service<
  ValidateAttestation,
  "GCP.BinaryAuthorization.ValidateAttestation",
  (
    attestor: Attestor,
  ) => Effect.Effect<
    (
      request: ValidateAttestationRequest,
    ) => Effect.Effect<
      binaryauthorization.ValidateAttestationOccurrenceResponse,
      binaryauthorization.ValidateAttestationOccurrenceProjectsAttestorsError,
      RuntimeContext
    >
  >
> {}

export const ValidateAttestation = Binding.Service<ValidateAttestation>(
  "GCP.BinaryAuthorization.ValidateAttestation",
);
