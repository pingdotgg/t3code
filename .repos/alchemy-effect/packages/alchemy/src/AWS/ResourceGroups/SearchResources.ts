import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-groups:SearchResources`.
 *
 * Runs an ad-hoc resource query (the same `TAG_FILTERS_1_0` /
 * `CLOUDFORMATION_STACK_1_0` syntax a query-based group is defined with)
 * and returns the matching resource ARNs — a group-less preview of what a
 * query would capture. Account-level: the query is chosen per request, so
 * the grant is on `*` (including the Tagging API / CloudFormation
 * read-through permissions the search fans out to). Provide the
 * implementation with `Effect.provide(AWS.ResourceGroups.SearchResourcesHttp)`.
 * @binding
 * @section Searching Resources
 * @example Find Resources By Tag
 * ```typescript
 * // init
 * const searchResources = yield* AWS.ResourceGroups.SearchResources();
 *
 * // runtime
 * const { ResourceIdentifiers } = yield* searchResources({
 *   ResourceQuery: {
 *     Type: "TAG_FILTERS_1_0",
 *     Query: JSON.stringify({
 *       ResourceTypeFilters: ["AWS::AllSupported"],
 *       TagFilters: [{ Key: "env", Values: ["prod"] }],
 *     }),
 *   },
 * });
 * ```
 */
export interface SearchResources extends Binding.Service<
  SearchResources,
  "AWS.ResourceGroups.SearchResources",
  () => Effect.Effect<
    (
      request: resourcegroups.SearchResourcesInput,
    ) => Effect.Effect<
      resourcegroups.SearchResourcesOutput,
      resourcegroups.SearchResourcesError
    >
  >
> {}
export const SearchResources = Binding.Service<SearchResources>(
  "AWS.ResourceGroups.SearchResources",
);
