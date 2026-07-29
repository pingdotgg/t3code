import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListFindingsFilters`.
 *
 * Retrieves a subset of information about all the findings filters for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListFindingsFiltersHttp)`.
 * @binding
 * @section Custom Data Identifiers & Lists
 * @example List Findings Filters
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listFindingsFilters = yield* AWS.Macie2.ListFindingsFilters();
 *
 * // runtime
 * const { findingsFilterListItems } = yield* listFindingsFilters();
 * ```
 */
export interface ListFindingsFilters extends Binding.Service<
  ListFindingsFilters,
  "AWS.Macie2.ListFindingsFilters",
  () => Effect.Effect<
    (
      request?: macie2.ListFindingsFiltersRequest,
    ) => Effect.Effect<
      macie2.ListFindingsFiltersResponse,
      macie2.ListFindingsFiltersError
    >
  >
> {}
export const ListFindingsFilters = Binding.Service<ListFindingsFilters>(
  "AWS.Macie2.ListFindingsFilters",
);
