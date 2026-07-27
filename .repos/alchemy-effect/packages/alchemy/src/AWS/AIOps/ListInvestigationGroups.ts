import type * as aiops from "@distilled.cloud/aws/aiops";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `aiops:ListInvestigationGroups`.
 *
 * Enumerates the Region's investigation groups (each item carries the
 * group's name and ARN). An account holds at most one investigation group
 * per Region, so this doubles as an existence probe. Provide the
 * implementation with
 * `Effect.provide(AWS.AIOps.ListInvestigationGroupsHttp)`.
 * @binding
 * @section Listing Investigation Groups
 * @example Discover the Region's Investigation Group
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInvestigationGroups = yield* AWS.AIOps.ListInvestigationGroups();
 *
 * // runtime
 * const { investigationGroups } = yield* listInvestigationGroups();
 * for (const group of investigationGroups ?? []) {
 *   yield* Effect.log(`${group.name}: ${group.arn}`);
 * }
 * ```
 */
export interface ListInvestigationGroups extends Binding.Service<
  ListInvestigationGroups,
  "AWS.AIOps.ListInvestigationGroups",
  () => Effect.Effect<
    (
      request?: aiops.ListInvestigationGroupsInput,
    ) => Effect.Effect<
      aiops.ListInvestigationGroupsOutput,
      aiops.ListInvestigationGroupsError
    >
  >
> {}
export const ListInvestigationGroups = Binding.Service<ListInvestigationGroups>(
  "AWS.AIOps.ListInvestigationGroups",
);
