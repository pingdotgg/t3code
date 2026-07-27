import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudtrail:ListPublicKeys`.
 *
 * An account-level operation (no resource argument) that returns the public
 * keys used to sign CloudTrail digest files in the region — the building
 * block for verifying log-file integrity at runtime. Provide the
 * implementation with `Effect.provide(AWS.CloudTrail.ListPublicKeysHttp)`.
 * @binding
 * @section Verifying Log Integrity
 * @example List Digest Public Keys
 * ```typescript
 * // init — account-level binding takes no resource
 * const listPublicKeys = yield* AWS.CloudTrail.ListPublicKeys();
 *
 * // runtime
 * const result = yield* listPublicKeys();
 * console.log(result.PublicKeyList?.map((k) => k.Fingerprint));
 * ```
 */
export interface ListPublicKeys extends Binding.Service<
  ListPublicKeys,
  "AWS.CloudTrail.ListPublicKeys",
  () => Effect.Effect<
    (
      request?: cloudtrail.ListPublicKeysRequest,
    ) => Effect.Effect<
      cloudtrail.ListPublicKeysResponse,
      cloudtrail.ListPublicKeysError
    >
  >
> {}
export const ListPublicKeys = Binding.Service<ListPublicKeys>(
  "AWS.CloudTrail.ListPublicKeys",
);
