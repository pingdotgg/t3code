import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GenerateMacRequest extends Omit<
  kms.GenerateMacRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateMac`.
 *
 * Bind this operation to an HMAC KMS {@link Key} (or the `alias/...` name of
 * a pre-existing key) to get a callable that automatically injects the
 * `KeyId`. Computes an HMAC inside KMS — the MAC key never leaves the HSM,
 * so any party with `kms:VerifyMac` can validate tokens without ever
 * holding the shared secret.
 *
 * @binding
 * @section Message Authentication
 * @example Compute an HMAC
 * ```typescript
 * const generateMac = yield* AWS.KMS.GenerateMac(hmacKey);
 *
 * const { Mac } = yield* generateMac({
 *   Message: new TextEncoder().encode("session-token-payload"),
 *   MacAlgorithm: "HMAC_SHA_256",
 * });
 * ```
 */
export interface GenerateMac extends Binding.Service<
  GenerateMac,
  "AWS.KMS.GenerateMac",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateMacRequest,
    ) => Effect.Effect<kms.GenerateMacResponse, kms.GenerateMacError>
  >
> {}

export const GenerateMac = Binding.Service<GenerateMac>("AWS.KMS.GenerateMac");
