import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `UploadArchive` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface UploadArchiveRequest extends Omit<
  glacier.UploadArchiveInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `UploadArchive` operation (IAM action
 * `glacier:UploadArchive` on the vault ARN).
 *
 * Uploads an archive to the bound {@link Vault} in a single request (up to
 * 4 GiB; use the multipart bindings for larger archives). The response
 * carries the new `archiveId` — Glacier has no list-archives API outside of
 * inventory jobs, so persist it.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.UploadArchiveHttp)`.
 * @binding
 * @section Uploading Archives
 * @example Upload a small archive
 * ```typescript
 * const uploadArchive = yield* AWS.Glacier.UploadArchive(vault);
 *
 * const { archiveId, checksum } = yield* uploadArchive({
 *   archiveDescription: "nightly backup",
 *   checksum: treeHash,
 *   body: payload,
 * });
 * ```
 */
export interface UploadArchive extends Binding.Service<
  UploadArchive,
  "AWS.Glacier.UploadArchive",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: UploadArchiveRequest,
    ) => Effect.Effect<
      glacier.ArchiveCreationOutput,
      glacier.UploadArchiveError
    >
  >
> {}
export const UploadArchive = Binding.Service<UploadArchive>(
  "AWS.Glacier.UploadArchive",
);
