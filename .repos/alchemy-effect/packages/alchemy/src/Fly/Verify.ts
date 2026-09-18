import type { VerifySecretKeyError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface VerifyRequest {
  /** Original payload. */
  plaintext: Uint8Array | ArrayLike<number>;
  /** Signature produced by {@link Sign}. */
  signature: Uint8Array | ArrayLike<number>;
}

export interface VerifyResult {
  /** Fly returns 200 only when the signature is valid. */
  valid: true;
}

/**
 * Verify a signature with a Fly {@link SecretKey}. The App and key
 * name are fixed by `Verify(key)`.
 *
 *
 * ### Verify a signature
 * Provide {@link VerifyHttp}. A bad signature is a typed error from
 * the Machines API, not `valid: false`.
 *
 * **Example:** Verify
 * ```typescript
 * const verify = yield* Fly.Verify(Signing);
 * const { valid } = yield* verify({ plaintext, signature });
 * ```
 *
 * @binding
 */
export interface Verify extends Binding.Service<
  Verify,
  "Fly.Verify",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: VerifyRequest,
    ) => Effect.Effect<VerifyResult, VerifySecretKeyError, RuntimeContext>
  >
> {}

export const Verify = Binding.Service<Verify>("Fly.Verify");
