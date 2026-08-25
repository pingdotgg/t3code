import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:StopEngagement`.
 *
 * Stop a running engagement, halting any further stages of the contact's
 * engagement plan — e.g. once the incident is acknowledged or resolved.
 * Engagement ARNs are minted at runtime by `StartEngagement`, so this
 * binding is account-scoped.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.StopEngagementHttp)`.
 * @binding
 * @section Managing Engagements
 * @example Stop an Engagement After Resolution
 * ```typescript
 * const stopEngagement = yield* AWS.SSMContacts.StopEngagement();
 *
 * yield* stopEngagement({
 *   EngagementId: engagementArn,
 *   Reason: "incident resolved",
 * });
 * ```
 */
export interface StopEngagement extends Binding.Service<
  StopEngagement,
  "AWS.SSMContacts.StopEngagement",
  () => Effect.Effect<
    (
      request: ssm.StopEngagementRequest,
    ) => Effect.Effect<ssm.StopEngagementResult, ssm.StopEngagementError>
  >
> {}
export const StopEngagement = Binding.Service<StopEngagement>(
  "AWS.SSMContacts.StopEngagement",
);
