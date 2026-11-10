import type * as sdb from "@distilled.cloud/aws/simpledb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Domain } from "./Domain.ts";

export interface PutAttributesRequest extends Omit<sdb.PutAttributesRequest, "DomainName"> {}

/**
 * Runtime binding for `sdb:PutAttributes`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that automatically injects the domain name.
 * ### Writing Items
 * **Example:** Put Attributes on an Item
 * ```typescript
 * const putAttributes = yield* AWS.SimpleDB.PutAttributes(domain);
 *
 * yield* putAttributes({
 *   ItemName: "user#123",
 *   Attributes: [
 *     { Name: "email", Value: "a@b.com", Replace: true },
 *     { Name: "plan", Value: "pro", Replace: true },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface PutAttributes extends Binding.Service<
  PutAttributes,
  "AWS.SimpleDB.PutAttributes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: PutAttributesRequest,
    ) => Effect.Effect<sdb.PutAttributesResponse, sdb.PutAttributesError, RuntimeContext>
  >
> {}
export const PutAttributes = Binding.Service<PutAttributes>("AWS.SimpleDB.PutAttributes");
