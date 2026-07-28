import type * as aiops from "@distilled.cloud/aws/aiops";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InvestigationGroup } from "./InvestigationGroup.ts";

/**
 * Runtime binding for `aiops:GetInvestigationGroupPolicy`.
 *
 * Reads the IAM resource policy attached to the bound
 * {@link InvestigationGroup} (the policy that lets principals like
 * `aiops.alarms.cloudwatch.amazonaws.com` create investigations), returned
 * as a JSON string. Fails with the typed `ResourceNotFoundException` when no
 * policy is attached. The group's ARN is injected from the binding. Provide
 * the implementation with
 * `Effect.provide(AWS.AIOps.GetInvestigationGroupPolicyHttp)`.
 * @binding
 * @section Reading the Resource Policy
 * @example Audit Who Can Start Investigations
 * ```typescript
 * // init — grants aiops:GetInvestigationGroupPolicy on the group
 * const getInvestigationGroupPolicy =
 *   yield* AWS.AIOps.GetInvestigationGroupPolicy(group);
 *
 * // runtime — no policy attached surfaces as a typed error
 * const attached = yield* getInvestigationGroupPolicy().pipe(
 *   Effect.map((r) => r.policy),
 *   Effect.catchTag("ResourceNotFoundException", () =>
 *     Effect.succeed(undefined),
 *   ),
 * );
 * ```
 */
export interface GetInvestigationGroupPolicy extends Binding.Service<
  GetInvestigationGroupPolicy,
  "AWS.AIOps.GetInvestigationGroupPolicy",
  (
    group: InvestigationGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      aiops.GetInvestigationGroupPolicyResponse,
      aiops.GetInvestigationGroupPolicyError
    >
  >
> {}
export const GetInvestigationGroupPolicy =
  Binding.Service<GetInvestigationGroupPolicy>(
    "AWS.AIOps.GetInvestigationGroupPolicy",
  );
