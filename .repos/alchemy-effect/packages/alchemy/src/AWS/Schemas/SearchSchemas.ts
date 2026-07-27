import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Registry } from "./Registry.ts";

/**
 * Runtime binding for `schemas:SearchSchemas`.
 *
 * Searches the bound {@link Registry}'s schemas by keyword — matching both
 * schema names and content — so a function can discover event contracts at
 * runtime. The registry name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Schemas.SearchSchemasHttp)`.
 * @binding
 * @section Searching a Registry
 * @example Find Schemas By Keyword
 * ```typescript
 * // init — bind the operation to the registry
 * const searchSchemas = yield* AWS.Schemas.SearchSchemas(registry);
 *
 * // runtime
 * const { Schemas } = yield* searchSchemas({ Keywords: "order" });
 * const names = (Schemas ?? []).map((s) => s.SchemaName);
 * ```
 */
export interface SearchSchemas extends Binding.Service<
  SearchSchemas,
  "AWS.Schemas.SearchSchemas",
  (registry: Registry) => Effect.Effect<
    (request?: {
      /** Keywords matched against schema names and content. */
      Keywords?: string;
      /** The maximum number of results to return per page. */
      Limit?: number;
      /** The pagination token from a previous response. */
      NextToken?: string;
    }) => Effect.Effect<
      schemas.SearchSchemasResponse,
      schemas.SearchSchemasError
    >
  >
> {}
export const SearchSchemas = Binding.Service<SearchSchemas>(
  "AWS.Schemas.SearchSchemas",
);
