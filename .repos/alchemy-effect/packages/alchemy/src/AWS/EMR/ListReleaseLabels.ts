import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `elasticmapreduce:ListReleaseLabels` — lists the EMR release labels available in the region, newest first.
 * @binding
 * @section Release Catalog
 * @example Find the Latest Release
 * ```typescript
 * const listReleaseLabels = yield* AWS.EMR.ListReleaseLabels();
 *
 * const { ReleaseLabels } = yield* listReleaseLabels();
 * const latest = ReleaseLabels?.[0];
 * ```
 */
export interface ListReleaseLabels extends Binding.Service<
  ListReleaseLabels,
  "AWS.EMR.ListReleaseLabels",
  () => Effect.Effect<
    (
      request?: SVC.ListReleaseLabelsInput,
    ) => Effect.Effect<SVC.ListReleaseLabelsOutput, SVC.ListReleaseLabelsError>
  >
> {}
export const ListReleaseLabels = Binding.Service<ListReleaseLabels>(
  "AWS.EMR.ListReleaseLabels",
);
