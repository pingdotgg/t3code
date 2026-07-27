import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `DeleteArchive` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface DeleteArchiveRequest extends Omit<
  glacier.DeleteArchiveInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `DeleteArchive` operation (IAM action
 * `glacier:DeleteArchive` on the vault ARN).
 *
 * Deletes an archive from the bound {@link Vault}. The operation is
 * idempotent — deleting an already-deleted archive is not an error.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.DeleteArchiveHttp)`.
 * @binding
 * @section Deleting Archives
 * @example Delete an archive by ID
 * ```typescript
 * const deleteArchive = yield* AWS.Glacier.DeleteArchive(vault);
 *
 * yield* deleteArchive({ archiveId });
 * ```
 */
export interface DeleteArchive extends Binding.Service<
  DeleteArchive,
  "AWS.Glacier.DeleteArchive",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: DeleteArchiveRequest,
    ) => Effect.Effect<
      glacier.DeleteArchiveResponse,
      glacier.DeleteArchiveError
    >
  >
> {}
export const DeleteArchive = Binding.Service<DeleteArchive>(
  "AWS.Glacier.DeleteArchive",
);
