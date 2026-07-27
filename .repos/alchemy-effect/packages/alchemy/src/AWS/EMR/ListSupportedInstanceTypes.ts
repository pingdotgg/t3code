import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `elasticmapreduce:ListSupportedInstanceTypes` — lists the EC2 instance types a given EMR release supports in the region.
 * @binding
 * @section Release Catalog
 * @example List Instance Types for a Release
 * ```typescript
 * const listInstanceTypes = yield* AWS.EMR.ListSupportedInstanceTypes();
 *
 * const { SupportedInstanceTypes } = yield* listInstanceTypes({
 *   ReleaseLabel: "emr-7.5.0",
 * });
 * ```
 */
export interface ListSupportedInstanceTypes extends Binding.Service<
  ListSupportedInstanceTypes,
  "AWS.EMR.ListSupportedInstanceTypes",
  () => Effect.Effect<
    (
      request: SVC.ListSupportedInstanceTypesInput,
    ) => Effect.Effect<
      SVC.ListSupportedInstanceTypesOutput,
      SVC.ListSupportedInstanceTypesError
    >
  >
> {}
export const ListSupportedInstanceTypes =
  Binding.Service<ListSupportedInstanceTypes>(
    "AWS.EMR.ListSupportedInstanceTypes",
  );
