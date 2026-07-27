import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetListingRequest extends Omit<
  datazone.GetListingInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetListing`.
 *
 * Reads a published listing in the bound domain by id. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetListingHttp)`.
 * @binding
 * @section Searching the Catalog
 * @example Read a Listing
 * ```typescript
 * // init — bind the operation to the domain
 * const getListing = yield* AWS.DataZone.GetListing(domain);
 *
 * // runtime
 * const listing = yield* getListing({ identifier: listingId });
 * ```
 */
export interface GetListing extends Binding.Service<
  GetListing,
  "AWS.DataZone.GetListing",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetListingRequest,
    ) => Effect.Effect<datazone.GetListingOutput, datazone.GetListingError>
  >
> {}
export const GetListing = Binding.Service<GetListing>(
  "AWS.DataZone.GetListing",
);
