import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:AcceptPage`.
 *
 * Acknowledge a page with the accept code Incident Manager delivered to
 * the contact's channel — `READ` marks it seen, `DELIVERED` confirms
 * receipt. Acknowledging stops further escalation stages.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.AcceptPageHttp)`.
 * @binding
 * @section Working with Pages
 * @example Acknowledge a Page
 * ```typescript
 * const acceptPage = yield* AWS.SSMContacts.AcceptPage();
 *
 * yield* acceptPage({
 *   PageId: pageArn,
 *   AcceptType: "READ",
 *   AcceptCode: "425440",
 * });
 * ```
 */
export interface AcceptPage extends Binding.Service<
  AcceptPage,
  "AWS.SSMContacts.AcceptPage",
  () => Effect.Effect<
    (
      request: ssm.AcceptPageRequest,
    ) => Effect.Effect<ssm.AcceptPageResult, ssm.AcceptPageError>
  >
> {}
export const AcceptPage = Binding.Service<AcceptPage>(
  "AWS.SSMContacts.AcceptPage",
);
