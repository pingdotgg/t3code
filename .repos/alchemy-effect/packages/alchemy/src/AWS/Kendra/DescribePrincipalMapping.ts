import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `DescribePrincipalMapping` request with `IndexId` injected from the bound index.
 */
export interface DescribePrincipalMappingRequest extends Omit<
  kendra.DescribePrincipalMappingRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `DescribePrincipalMapping` operation (IAM action
 * `kendra:DescribePrincipalMapping`), scoped to one {@link Index}.
 *
 * Describes the processing state of the `PUT`/`DELETE` actions applied
 * to a group's principal mapping.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.DescribePrincipalMappingHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Inspect Mapping Actions
 * ```typescript
 * const describeMapping = yield* AWS.Kendra.DescribePrincipalMapping(index);
 *
 * const mapping = yield* describeMapping({ GroupId: "engineering" });
 * console.log(mapping.GroupOrderingIdSummaries);
 * ```
 */
export interface DescribePrincipalMapping extends Binding.Service<
  DescribePrincipalMapping,
  "AWS.Kendra.DescribePrincipalMapping",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: DescribePrincipalMappingRequest,
    ) => Effect.Effect<
      kendra.DescribePrincipalMappingResponse,
      kendra.DescribePrincipalMappingError
    >
  >
> {}
export const DescribePrincipalMapping =
  Binding.Service<DescribePrincipalMapping>(
    "AWS.Kendra.DescribePrincipalMapping",
  );
