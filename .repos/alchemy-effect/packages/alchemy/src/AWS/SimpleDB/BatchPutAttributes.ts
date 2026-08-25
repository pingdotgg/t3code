import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

export interface BatchPutAttributesRequest extends Omit<
  sdb.BatchPutAttributesRequest,
  "DomainName"
> {}

/**
 * Runtime binding for `sdb:BatchPutAttributes`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that automatically injects the domain name. Puts attributes on up
 * to 25 items in a single call.
 * @binding
 * @section Writing Items
 * @example Batch Put Multiple Items
 * ```typescript
 * const batchPutAttributes = yield* AWS.SimpleDB.BatchPutAttributes(domain);
 *
 * yield* batchPutAttributes({
 *   Items: [
 *     {
 *       ItemName: "user#1",
 *       Attributes: [{ Name: "plan", Value: "free", Replace: true }],
 *     },
 *     {
 *       ItemName: "user#2",
 *       Attributes: [{ Name: "plan", Value: "pro", Replace: true }],
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchPutAttributes extends Binding.Service<
  BatchPutAttributes,
  "AWS.SimpleDB.BatchPutAttributes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: BatchPutAttributesRequest,
    ) => Effect.Effect<
      sdb.BatchPutAttributesResponse,
      sdb.BatchPutAttributesError,
      RuntimeContext
    >
  >
> {}
export const BatchPutAttributes = Binding.Service<BatchPutAttributes>(
  "AWS.SimpleDB.BatchPutAttributes",
);
