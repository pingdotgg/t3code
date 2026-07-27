import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

export interface DeleteAttributesRequest extends Omit<
  sdb.DeleteAttributesRequest,
  "DomainName"
> {}

/**
 * Runtime binding for `sdb:DeleteAttributes`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that automatically injects the domain name. Omitting `Attributes`
 * deletes the whole item.
 * @binding
 * @section Deleting Items
 * @example Delete a Whole Item
 * ```typescript
 * const deleteAttributes = yield* AWS.SimpleDB.DeleteAttributes(domain);
 *
 * yield* deleteAttributes({ ItemName: "user#123" });
 * ```
 *
 * @example Delete a Single Attribute
 * ```typescript
 * yield* deleteAttributes({
 *   ItemName: "user#123",
 *   Attributes: [{ Name: "plan" }],
 * });
 * ```
 */
export interface DeleteAttributes extends Binding.Service<
  DeleteAttributes,
  "AWS.SimpleDB.DeleteAttributes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: DeleteAttributesRequest,
    ) => Effect.Effect<
      sdb.DeleteAttributesResponse,
      sdb.DeleteAttributesError,
      RuntimeContext
    >
  >
> {}
export const DeleteAttributes = Binding.Service<DeleteAttributes>(
  "AWS.SimpleDB.DeleteAttributes",
);
