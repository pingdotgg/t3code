import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
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
 * @binding
 * @section Deleting Items
 * @example Batch Delete Whole Items
 * ```typescript
 * const batchDeleteAttributes =
 *   yield* AWS.SimpleDB.BatchDeleteAttributes(domain);
 *
 * yield* batchDeleteAttributes({
 *   Items: [{ ItemName: "user#1" }, { ItemName: "user#2" }],
 * });
 * ```
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
