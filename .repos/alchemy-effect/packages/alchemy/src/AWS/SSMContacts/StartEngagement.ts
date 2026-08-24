import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Contact } from "./Contact.ts";

/**
 * Runtime binding for `ssm-contacts:StartEngagement`.
 *
 * Page the bound contact (or run its escalation plan) — Incident Manager
 * works through the contact's engagement plan, sending the subject and
 * content over each stage's channels until the page is acknowledged. The
 * contact's ARN is injected as `ContactId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.StartEngagementHttp)`.
 * @binding
 * @section Starting Engagements
 * @example Page the On-Call Contact
 * ```typescript
 * // init — bind the operation to the contact
 * const startEngagement = yield* AWS.SSMContacts.StartEngagement(oncall);
 *
 * // runtime — page the contact when an alert fires
 * const { EngagementArn } = yield* startEngagement({
 *   Sender: "alert-bot",
 *   Subject: "Database CPU at 95%",
 *   Content: "Primary DB is saturated - please investigate.",
 * });
 * ```
 */
export interface StartEngagement extends Binding.Service<
  StartEngagement,
  "AWS.SSMContacts.StartEngagement",
  (
    contact: Contact,
  ) => Effect.Effect<
    (
      request: Omit<ssm.StartEngagementRequest, "ContactId">,
    ) => Effect.Effect<ssm.StartEngagementResult, ssm.StartEngagementError>
  >
> {}
export const StartEngagement = Binding.Service<StartEngagement>(
  "AWS.SSMContacts.StartEngagement",
);
