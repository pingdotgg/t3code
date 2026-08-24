import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `ListMultipartUploads` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface ListMultipartUploadsRequest extends Omit<
  glacier.ListMultipartUploadsInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `ListMultipartUploads` operation (IAM action
 * `glacier:ListMultipartUploads` on the vault ARN).
 *
 * Lists the in-progress multipart uploads for the bound {@link Vault} —
 * useful for finding and aborting stale uploads that still accrue
 * storage.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.ListMultipartUploadsHttp)`.
 * @binding
 * @section Uploading Archives
 * @example List in-progress uploads
 * ```typescript
 * const listMultipartUploads =
 *   yield* AWS.Glacier.ListMultipartUploads(vault);
 *
 * const { UploadsList } = yield* listMultipartUploads();
 * ```
 */
export interface ListMultipartUploads extends Binding.Service<
  ListMultipartUploads,
  "AWS.Glacier.ListMultipartUploads",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: ListMultipartUploadsRequest,
    ) => Effect.Effect<
      glacier.ListMultipartUploadsOutput,
      glacier.ListMultipartUploadsError
    >
  >
> {}
export const ListMultipartUploads = Binding.Service<ListMultipartUploads>(
  "AWS.Glacier.ListMultipartUploads",
);
