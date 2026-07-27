import type * as RE2 from "@distilled.cloud/aws/resource-explorer-2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-explorer-2:ListSupportedResourceTypes`.
 *
 * Enumerates the resource types Resource Explorer can index and search —
 * the discovery half of query-building: validate a `service:`/`resourcetype:`
 * filter before searching, or drive a resource-type picker. Account-level
 * operation, so the binding takes no resource argument. Provide the
 * implementation with
 * `Effect.provide(AWS.ResourceExplorer.ListSupportedResourceTypesHttp)`.
 * @binding
 * @section Listing Resources
 * @example Enumerate Searchable Resource Types
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSupportedResourceTypes =
 *   yield* AWS.ResourceExplorer.ListSupportedResourceTypes();
 *
 * // runtime
 * const { ResourceTypes } = yield* listSupportedResourceTypes();
 * const s3Types = (ResourceTypes ?? []).filter((t) => t.Service === "s3");
 * ```
 */
export interface ListSupportedResourceTypes extends Binding.Service<
  ListSupportedResourceTypes,
  "AWS.ResourceExplorer.ListSupportedResourceTypes",
  () => Effect.Effect<
    (
      request?: RE2.ListSupportedResourceTypesInput,
    ) => Effect.Effect<
      RE2.ListSupportedResourceTypesOutput,
      RE2.ListSupportedResourceTypesError
    >
  >
> {}
export const ListSupportedResourceTypes =
  Binding.Service<ListSupportedResourceTypes>(
    "AWS.ResourceExplorer.ListSupportedResourceTypes",
  );
