import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListResourceSets}.
 */
export interface ListResourceSetsRequest extends fms.ListResourceSetsRequest {}

/**
 * Runtime binding for `fms:ListResourceSets`.
 *
 * Returns an array of `ResourceSetSummary` objects for the resource sets in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListResourceSetsHttp)`.
 * ### Resource Sets
 * **Example:** List Resource Sets
 * ```typescript
 * // init — account-level binding takes no resource
 * const listResourceSets = yield* AWS.FMS.ListResourceSets();
 *
 * // runtime
 * const result = yield* listResourceSets();
 * console.log(result.ResourceSets?.length);
 * ```
 *
 * @binding
 */
export interface ListResourceSets extends Binding.Service<
  ListResourceSets,
  "AWS.FMS.ListResourceSets",
  () => Effect.Effect<
    (
      request?: ListResourceSetsRequest,
    ) => Effect.Effect<fms.ListResourceSetsResponse, fms.ListResourceSetsError>
  >
> {}

export const ListResourceSets = Binding.Service<ListResourceSets>(
  "AWS.FMS.ListResourceSets",
);
