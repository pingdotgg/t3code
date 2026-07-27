import type * as aiops from "@distilled.cloud/aws/aiops";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InvestigationGroup } from "./InvestigationGroup.ts";

/**
 * Runtime binding for `aiops:ListTagsForResource`.
 *
 * Reads the tags on the bound {@link InvestigationGroup} — useful for
 * ownership/audit reporting from an ops function. The group's ARN is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.AIOps.ListTagsForResourceHttp)`.
 * @binding
 * @section Reading Tags
 * @example List the Group's Tags
 * ```typescript
 * // init — grants aiops:ListTagsForResource on the group
 * const listTagsForResource = yield* AWS.AIOps.ListTagsForResource(group);
 *
 * // runtime
 * const { tags } = yield* listTagsForResource();
 * yield* Effect.log(`owned by team ${tags?.Team}`);
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.AIOps.ListTagsForResource",
  (
    group: InvestigationGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      aiops.ListTagsForResourceOutput,
      aiops.ListTagsForResourceError
    >
  >
> {}
export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.AIOps.ListTagsForResource",
);
