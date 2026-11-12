import type * as sdb from "@distilled.cloud/aws/simpledb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Domain } from "./Domain.ts";

export interface BatchDeleteAttributesRequest extends Omit<
  sdb.BatchDeleteAttributesRequest,
  "DomainName"
> {}

/**
 * Runtime binding for `sdb:BatchDeleteAttributes`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that automatically injects the domain name. Deletes attributes
 * (or whole items, when an entry lists no attributes) on up to 25 items in a
 * single call.
 * ### Deleting Items
 * **Example:** Batch Delete Whole Items
 * ```typescript
 * const batchDeleteAttributes =
 *   yield* AWS.SimpleDB.BatchDeleteAttributes(domain);
 *
 * yield* batchDeleteAttributes({
 *   Items: [{ ItemName: "user#1" }, { ItemName: "user#2" }],
 * });
 * ```
 *
 * @binding
 */
export interface BatchDeleteAttributes extends Binding.Service<
  BatchDeleteAttributes,
  "AWS.SimpleDB.BatchDeleteAttributes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: BatchDeleteAttributesRequest,
    ) => Effect.Effect<
      sdb.BatchDeleteAttributesResponse,
      sdb.BatchDeleteAttributesError,
      RuntimeContext
    >
  >
> {}
export const BatchDeleteAttributes = Binding.Service<BatchDeleteAttributes>(
  "AWS.SimpleDB.BatchDeleteAttributes",
);
