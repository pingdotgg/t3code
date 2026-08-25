import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

export interface GetAttributesRequest extends Omit<
  sdb.GetAttributesRequest,
  "DomainName"
> {}

/**
 * Runtime binding for `sdb:GetAttributes`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that automatically injects the domain name.
 * @binding
 * @section Reading Items
 * @example Read an Item's Attributes
 * ```typescript
 * const getAttributes = yield* AWS.SimpleDB.GetAttributes(domain);
 *
 * const response = yield* getAttributes({
 *   ItemName: "user#123",
 *   ConsistentRead: true,
 * });
 * // response.Attributes: [{ Name: "email", Value: "a@b.com" }, ...]
 * ```
 */
export interface GetAttributes extends Binding.Service<
  GetAttributes,
  "AWS.SimpleDB.GetAttributes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetAttributesRequest,
    ) => Effect.Effect<
      sdb.GetAttributesResponse,
      sdb.GetAttributesError,
      RuntimeContext
    >
  >
> {}
export const GetAttributes = Binding.Service<GetAttributes>(
  "AWS.SimpleDB.GetAttributes",
);
