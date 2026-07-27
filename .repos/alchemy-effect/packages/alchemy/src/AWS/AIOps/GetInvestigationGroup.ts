import type * as aiops from "@distilled.cloud/aws/aiops";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InvestigationGroup } from "./InvestigationGroup.ts";

/**
 * Runtime binding for `aiops:GetInvestigationGroup`.
 *
 * Reads the bound {@link InvestigationGroup}'s full configuration — the
 * telemetry-access role, retention period, encryption, tag key boundaries,
 * chatbot notification channels, and cross-account configurations — so an
 * ops function can audit or report on the Region's investigation setup. The
 * group's ARN is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.AIOps.GetInvestigationGroupHttp)`.
 * @binding
 * @section Reading the Investigation Group
 * @example Inspect the Group's Configuration
 * ```typescript
 * // init — grants aiops:GetInvestigationGroup on the group
 * const getInvestigationGroup = yield* AWS.AIOps.GetInvestigationGroup(group);
 *
 * // runtime
 * const detail = yield* getInvestigationGroup();
 * yield* Effect.log(
 *   `${detail.name} retains investigations for ${detail.retentionInDays} days`,
 * );
 * ```
 */
export interface GetInvestigationGroup extends Binding.Service<
  GetInvestigationGroup,
  "AWS.AIOps.GetInvestigationGroup",
  (
    group: InvestigationGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      aiops.GetInvestigationGroupResponse,
      aiops.GetInvestigationGroupError
    >
  >
> {}
export const GetInvestigationGroup = Binding.Service<GetInvestigationGroup>(
  "AWS.AIOps.GetInvestigationGroup",
);
