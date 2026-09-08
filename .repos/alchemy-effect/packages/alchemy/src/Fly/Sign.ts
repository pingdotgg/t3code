import type { SignSecretKeyError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface SignRequest {
  /** Bytes to sign. */
  plaintext: Uint8Array | ArrayLike<number>;
}

export interface SignResult {
  signature: Uint8Array;
}

/**
 * Sign with a Fly {@link SecretKey} (`nacl_sign`, `hs256`, `es256`,
 * …). The private key never leaves Fly KMS.
 *
 *
 * ### Sign a payload
 * The App and key name are fixed by `Sign(key)`. Provide
 * {@link SignHttp} on the Action or Service Effect.
 *
 * **Example:** Sign
 * ```typescript
 * const sign = yield* Fly.Sign(Signing);
 * const { signature } = yield* sign({
 *   plaintext: new TextEncoder().encode("release-manifest-v1"),
 * });
 * ```
 *
 * @binding
 */
export interface Sign extends Binding.Service<
  Sign,
  "Fly.Sign",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: SignRequest,
    ) => Effect.Effect<SignResult, SignSecretKeyError, RuntimeContext>
  >
> {}

export const Sign = Binding.Service<Sign>("Fly.Sign");
