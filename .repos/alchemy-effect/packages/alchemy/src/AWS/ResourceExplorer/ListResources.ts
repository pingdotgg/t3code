import type * as RE2 from "@distilled.cloud/aws/resource-explorer-2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { View } from "./View.ts";

export interface ListResourcesRequest extends Omit<
  RE2.ListResourcesInput,
  "ViewArn"
> {}

/**
 * Runtime binding for `resource-explorer-2:ListResources`.
 *
 * Enumerates the resources visible through the bound {@link View} using a
 * structured filter (instead of `Search`'s free-form query string) — the
 * building block of inventory automation: page through every resource the
 * view exposes and act on each one. The view's ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.ResourceExplorer.ListResourcesHttp)`.
 * @binding
 * @section Listing Resources
 * @example List Resources Through a View
 * ```typescript
 * // init — bind the operation to the view
 * const listResources = yield* AWS.ResourceExplorer.ListResources(view);
 *
 * // runtime
 * const page = yield* listResources({
 *   Filters: { FilterString: "service:s3" },
 *   MaxResults: 100,
 * });
 * for (const resource of page.Resources ?? []) {
 *   yield* Effect.log(`${resource.ResourceType}: ${resource.Arn}`);
 * }
 * ```
 */
export interface ListResources extends Binding.Service<
  ListResources,
  "AWS.ResourceExplorer.ListResources",
  <V extends View>(
    view: V,
  ) => Effect.Effect<
    (
      request?: ListResourcesRequest,
    ) => Effect.Effect<RE2.ListResourcesOutput, RE2.ListResourcesError>
  >
> {}
export const ListResources = Binding.Service<ListResources>(
  "AWS.ResourceExplorer.ListResources",
);
