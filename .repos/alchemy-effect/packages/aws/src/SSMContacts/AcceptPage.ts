import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `ssm-contacts:AcceptPage`.
 *
 * Acknowledge a page with the accept code Incident Manager delivered to
 * the contact's channel — `READ` marks it seen, `DELIVERED` confirms
 * receipt. Acknowledging stops further escalation stages.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.AcceptPageHttp)`.
 * ### Working with Pages
 * **Example:** Acknowledge a Page
 * ```typescript
 * const acceptPage = yield* AWS.SSMContacts.AcceptPage();
 *
 * yield* acceptPage({
 *   PageId: pageArn,
 *   AcceptType: "READ",
 *   AcceptCode: "425440",
 * });
 * ```
 *
 * @binding
 */
export interface AcceptPage extends Binding.Service<
  AcceptPage,
  "AWS.SSMContacts.AcceptPage",
  () => Effect.Effect<
    (request: ssm.AcceptPageRequest) => Effect.Effect<ssm.AcceptPageResult, ssm.AcceptPageError>
  >
> {}
export const AcceptPage = Binding.Service<AcceptPage>("AWS.SSMContacts.AcceptPage");
