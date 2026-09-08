import type { EncryptSecretKeyError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface EncryptRequest {
  /** Bytes to encrypt. */
  plaintext: Uint8Array | ArrayLike<number>;
  /** Optional AEAD associated data. */
  associatedData?: Uint8Array | ArrayLike<number>;
}

export interface EncryptResult {
  ciphertext: Uint8Array;
}

/**
 * Encrypt with a Fly {@link SecretKey} (`nacl_box`, `nacl_secretbox`,
 * `xaes256gcm`, …). The App and key name are fixed by `Encrypt(key)`.
 *
 *
 * ### Encrypt a payload
 * Provide {@link EncryptHttp} on the Action or Service Effect. Fly
 * crypto ops need a KMS token. Org API tokens are typed `Forbidden`.
 *
 * **Example:** Encrypt
 * ```typescript
 * const encrypt = yield* Fly.Encrypt(Box);
 * const { ciphertext } = yield* encrypt({
 *   plaintext: new TextEncoder().encode("attack at dawn"),
 * });
 * ```
 *
 * ### Associated data
 * `associatedData` is optional AEAD associated data. {@link Decrypt}
 * must pass the same bytes.
 *
 * **Example:** AEAD
 * ```typescript
 * const { ciphertext } = yield* encrypt({
 *   plaintext: bytes,
 *   associatedData: nonce,
 * });
 * ```
 *
 * @binding
 */
export interface Encrypt extends Binding.Service<
  Encrypt,
  "Fly.Encrypt",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: EncryptRequest,
    ) => Effect.Effect<EncryptResult, EncryptSecretKeyError, RuntimeContext>
  >
> {}

export const Encrypt = Binding.Service<Encrypt>("Fly.Encrypt");
