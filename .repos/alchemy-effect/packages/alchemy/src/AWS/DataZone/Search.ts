import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface SearchRequest extends Omit<
  datazone.SearchInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:Search`.
 *
 * Searches the bound domain's inventory — assets, glossaries, and data products visible to the calling project. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.SearchHttp)`.
 * @binding
 * @section Searching the Catalog
 * @example Search Assets by Text
 * ```typescript
 * // init — bind the operation to the domain
 * const search = yield* AWS.DataZone.Search(domain);
 *
 * // runtime
 * const result = yield* search({ searchScope: "ASSET", searchText: "orders" });
 * const names = result.items?.map((i) => i.assetItem?.name);
 * ```
 */
export interface Search extends Binding.Service<
  Search,
  "AWS.DataZone.Search",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: SearchRequest,
    ) => Effect.Effect<datazone.SearchOutput, datazone.SearchError>
  >
> {}
export const Search = Binding.Service<Search>("AWS.DataZone.Search");
