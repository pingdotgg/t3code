import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GenerateRandomRequest extends kms.GenerateRandomRequest {}

/**
 * Runtime binding for `kms:GenerateRandom`.
 *
 * Not scoped to a key — KMS produces cryptographically secure random bytes
 * from its FIPS 140-3 validated HSMs. The binding grants `kms:GenerateRandom`
 * on `*` (the action does not support resource-level scoping).
 *
 * The random `Plaintext` in the response is wrapped in `Redacted` so it
 * never leaks into logs — unwrap with `Redacted.value(...)` at the point of
 * use.
 *
 * @binding
 * @section Random Bytes
 * @example Generate 32 Random Bytes
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const generateRandom = yield* AWS.KMS.GenerateRandom();
 *
 * const { Plaintext } = yield* generateRandom({ NumberOfBytes: 32 });
 * const bytes = Redacted.isRedacted(Plaintext)
 *   ? Redacted.value(Plaintext)
 *   : Plaintext;
 * ```
 */
export interface GenerateRandom extends Binding.Service<
  GenerateRandom,
  "AWS.KMS.GenerateRandom",
  () => Effect.Effect<
    (
      request?: GenerateRandomRequest,
    ) => Effect.Effect<kms.GenerateRandomResponse, kms.GenerateRandomError>
  >
> {}

export const GenerateRandom = Binding.Service<GenerateRandom>(
  "AWS.KMS.GenerateRandom",
);
