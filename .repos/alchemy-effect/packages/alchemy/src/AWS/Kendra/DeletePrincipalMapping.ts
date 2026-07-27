import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `DeletePrincipalMapping` request with `IndexId` injected from the bound index.
 */
export interface DeletePrincipalMappingRequest extends Omit<
  kendra.DeletePrincipalMappingRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `DeletePrincipalMapping` operation (IAM action
 * `kendra:DeletePrincipalMapping`), scoped to one {@link Index}.
 *
 * Deletes a group's user-to-group mapping created with
 * {@link PutPrincipalMapping}.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.DeletePrincipalMappingHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Remove a Group Mapping
 * ```typescript
 * const deleteMapping = yield* AWS.Kendra.DeletePrincipalMapping(index);
 *
 * yield* deleteMapping({ GroupId: "engineering" });
 * ```
 */
export interface DeletePrincipalMapping extends Binding.Service<
  DeletePrincipalMapping,
  "AWS.Kendra.DeletePrincipalMapping",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: DeletePrincipalMappingRequest,
    ) => Effect.Effect<
      kendra.DeletePrincipalMappingResponse,
      kendra.DeletePrincipalMappingError
    >
  >
> {}
export const DeletePrincipalMapping = Binding.Service<DeletePrincipalMapping>(
  "AWS.Kendra.DeletePrincipalMapping",
);
