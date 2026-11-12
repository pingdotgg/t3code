import type * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CryptoKey } from "./CryptoKey.ts";

export interface EncryptRequest extends Omit<
  kms.EncryptProjectsLocationsKeyRingsCryptoKeysRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud KMS `cryptoKeys.encrypt`.
 *
 * Bind this operation to a {@link CryptoKey} in a Function/Action init
 * phase. Provide {@link EncryptHttp}. The CryptoKey purpose must be
 * `ENCRYPT_DECRYPT` and it must have an enabled primary version.
 *
 * ### Encrypting Data
 * **Example:** Encrypt a payload
 * ```typescript
 * const encrypt = yield* GCP.KMS.Encrypt(key);
 * const { ciphertext } = yield* encrypt({
 *   body: { plaintext: btoa("hello") },
 * });
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Encrypt extends Binding.Service<
  Encrypt,
  "GCP.KMS.Encrypt",
  (
    key: CryptoKey,
  ) => Effect.Effect<
    (
      request?: EncryptRequest,
    ) => Effect.Effect<
      kms.EncryptResponse,
      kms.EncryptProjectsLocationsKeyRingsCryptoKeysError,
      RuntimeContext
    >
  >
> {}

export const Encrypt = Binding.Service<Encrypt>("GCP.KMS.Encrypt");
