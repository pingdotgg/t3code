import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface SearchListingsRequest extends Omit<
  datazone.SearchListingsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:SearchListings`.
 *
 * Searches published listings (the catalog of subscribable assets and data products) in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.SearchListingsHttp)`.
 * @binding
 * @section Searching the Catalog
 * @example Find Subscribable Listings
 * ```typescript
 * // init — bind the operation to the domain
 * const searchListings = yield* AWS.DataZone.SearchListings(domain);
 *
 * // runtime
 * const result = yield* searchListings({ searchText: "customer" });
 * const listings = result.items?.map((i) => i.assetListing?.name);
 * ```
 */
export interface SearchListings extends Binding.Service<
  SearchListings,
  "AWS.DataZone.SearchListings",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request?: SearchListingsRequest,
    ) => Effect.Effect<
      datazone.SearchListingsOutput,
      datazone.SearchListingsError
    >
  >
> {}
export const SearchListings = Binding.Service<SearchListings>(
  "AWS.DataZone.SearchListings",
);
