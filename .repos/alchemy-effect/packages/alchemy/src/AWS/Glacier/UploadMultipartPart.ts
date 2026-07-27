import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `UploadMultipartPart` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface UploadMultipartPartRequest extends Omit<
  glacier.UploadMultipartPartInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `UploadMultipartPart` operation (IAM action
 * `glacier:UploadMultipartPart` on the vault ARN).
 *
 * Uploads one part of a multipart upload to the bound {@link Vault}. The
 * `range` field carries the part's byte range (e.g.
 * `bytes 0-8388607/*`) and `checksum` its SHA-256 tree hash.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.UploadMultipartPartHttp)`.
 * @binding
 * @section Uploading Archives
 * @example Upload one part
 * ```typescript
 * const uploadMultipartPart = yield* AWS.Glacier.UploadMultipartPart(vault);
 *
 * yield* uploadMultipartPart({
 *   uploadId,
 *   range: "bytes 0-8388607/*",
 *   checksum: partTreeHash,
 *   body: partBytes,
 * });
 * ```
 */
export interface UploadMultipartPart extends Binding.Service<
  UploadMultipartPart,
  "AWS.Glacier.UploadMultipartPart",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: UploadMultipartPartRequest,
    ) => Effect.Effect<
      glacier.UploadMultipartPartOutput,
      glacier.UploadMultipartPartError
    >
  >
> {}
export const UploadMultipartPart = Binding.Service<UploadMultipartPart>(
  "AWS.Glacier.UploadMultipartPart",
);
