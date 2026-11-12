import type * as sdb from "@distilled.cloud/aws/simpledb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Domain } from "./Domain.ts";

/**
 * Runtime binding for `sdb:DomainMetadata`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that returns the domain's item/attribute counts and sizes.
 * ### Domain Introspection
 * **Example:** Read Domain Metadata
 * ```typescript
 * const domainMetadata = yield* AWS.SimpleDB.DomainMetadata(domain);
 *
 * const metadata = yield* domainMetadata();
 * // metadata.ItemCount, metadata.AttributeValueCount, ...
 * ```
 *
 * @binding
 */
export interface DomainMetadata extends Binding.Service<
  DomainMetadata,
  "AWS.SimpleDB.DomainMetadata",
  (
    domain: Domain,
  ) => Effect.Effect<
    () => Effect.Effect<sdb.DomainMetadataResponse, sdb.DomainMetadataError, RuntimeContext>
  >
> {}
export const DomainMetadata = Binding.Service<DomainMetadata>("AWS.SimpleDB.DomainMetadata");
