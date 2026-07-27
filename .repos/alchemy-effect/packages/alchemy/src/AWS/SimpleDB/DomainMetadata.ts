import type * as sdb from "@distilled.cloud/aws/simpledb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

/**
 * Runtime binding for `sdb:DomainMetadata`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime to get a
 * callable that returns the domain's item/attribute counts and sizes.
 * @binding
 * @section Domain Introspection
 * @example Read Domain Metadata
 * ```typescript
 * const domainMetadata = yield* AWS.SimpleDB.DomainMetadata(domain);
 *
 * const metadata = yield* domainMetadata();
 * // metadata.ItemCount, metadata.AttributeValueCount, ...
 * ```
 */
export interface DomainMetadata extends Binding.Service<
  DomainMetadata,
  "AWS.SimpleDB.DomainMetadata",
  (
    domain: Domain,
  ) => Effect.Effect<
    () => Effect.Effect<
      sdb.DomainMetadataResponse,
      sdb.DomainMetadataError,
      RuntimeContext
    >
  >
> {}
export const DomainMetadata = Binding.Service<DomainMetadata>(
  "AWS.SimpleDB.DomainMetadata",
);
