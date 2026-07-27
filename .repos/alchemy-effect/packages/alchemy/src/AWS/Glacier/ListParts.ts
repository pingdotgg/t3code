import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `ListParts` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface ListPartsRequest extends Omit<
  glacier.ListPartsInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `ListParts` operation (IAM action
 * `glacier:ListParts` on the vault ARN).
 *
 * Lists the parts already uploaded for an in-progress multipart upload on
 * the bound {@link Vault}, sorted by byte range — the resume point after a
 * crashed uploader.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.ListPartsHttp)`.
 * @binding
 * @section Uploading Archives
 * @example List a multipart upload's parts
 * ```typescript
 * const listParts = yield* AWS.Glacier.ListParts(vault);
 *
 * const { Parts } = yield* listParts({ uploadId });
 * ```
 */
export interface ListParts extends Binding.Service<
  ListParts,
  "AWS.Glacier.ListParts",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: ListPartsRequest,
    ) => Effect.Effect<glacier.ListPartsOutput, glacier.ListPartsError>
  >
> {}
export const ListParts = Binding.Service<ListParts>("AWS.Glacier.ListParts");
