import type * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CryptoKey } from "./CryptoKey.ts";

export interface DecryptRequest extends Omit<
  kms.DecryptProjectsLocationsKeyRingsCryptoKeysRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud KMS `cryptoKeys.decrypt`.
 *
 * Bind this operation to a {@link CryptoKey} in a Function/Action init
 * phase. Provide {@link DecryptHttp}. The CryptoKey purpose must be
 * `ENCRYPT_DECRYPT`.
 *
 * ### Decrypting Data
 * **Example:** Decrypt a ciphertext
 * ```typescript
 * const decrypt = yield* GCP.KMS.Decrypt(key);
 * const { plaintext } = yield* decrypt({
 *   body: { ciphertext },
 * });
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Decrypt extends Binding.Service<
  Decrypt,
  "GCP.KMS.Decrypt",
  (
    key: CryptoKey,
  ) => Effect.Effect<
    (
      request?: DecryptRequest,
    ) => Effect.Effect<
      kms.DecryptResponse,
      kms.DecryptProjectsLocationsKeyRingsCryptoKeysError,
      RuntimeContext
    >
  >
> {}

export const Decrypt = Binding.Service<Decrypt>("GCP.KMS.Decrypt");
