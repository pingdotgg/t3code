import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface SearchTypesRequest extends Omit<
  datazone.SearchTypesInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:SearchTypes`.
 *
 * Searches asset types and form types registered in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.SearchTypesHttp)`.
 * @binding
 * @section Searching the Catalog
 * @example List Managed Asset Types
 * ```typescript
 * // init — bind the operation to the domain
 * const searchTypes = yield* AWS.DataZone.SearchTypes(domain);
 *
 * // runtime
 * const result = yield* searchTypes({ searchScope: "ASSET_TYPE", managed: true });
 * ```
 */
export interface SearchTypes extends Binding.Service<
  SearchTypes,
  "AWS.DataZone.SearchTypes",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: SearchTypesRequest,
    ) => Effect.Effect<datazone.SearchTypesOutput, datazone.SearchTypesError>
  >
> {}
export const SearchTypes = Binding.Service<SearchTypes>(
  "AWS.DataZone.SearchTypes",
);
