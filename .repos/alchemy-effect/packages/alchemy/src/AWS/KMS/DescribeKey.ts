import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface DescribeKeyRequest extends Omit<
  kms.DescribeKeyRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:DescribeKey`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) to get a callable that automatically injects the
 * `KeyId`. Useful at runtime to discover a key's state, spec, and supported
 * algorithms before choosing a cryptographic operation.
 *
 * @binding
 * @section Key Metadata
 * @example Inspect the Bound Key
 * ```typescript
 * const describeKey = yield* AWS.KMS.DescribeKey(key);
 *
 * const { KeyMetadata } = yield* describeKey();
 * // KeyMetadata.KeyState, KeyMetadata.KeySpec, ...
 * ```
 */
export interface DescribeKey extends Binding.Service<
  DescribeKey,
  "AWS.KMS.DescribeKey",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request?: DescribeKeyRequest,
    ) => Effect.Effect<kms.DescribeKeyResponse, kms.DescribeKeyError>
  >
> {}

export const DescribeKey = Binding.Service<DescribeKey>("AWS.KMS.DescribeKey");
