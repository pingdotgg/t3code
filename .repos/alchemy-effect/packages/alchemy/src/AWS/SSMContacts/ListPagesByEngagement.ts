import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:ListPagesByEngagement`.
 *
 * List the pages an engagement produced — one page per engaged contact
 * and escalation stage.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListPagesByEngagementHttp)`.
 * @binding
 * @section Working with Pages
 * @example List an Engagement's Pages
 * ```typescript
 * const listPagesByEngagement = yield* AWS.SSMContacts.ListPagesByEngagement();
 *
 * const { Pages } = yield* listPagesByEngagement({ EngagementId: engagementArn });
 * ```
 */
export interface ListPagesByEngagement extends Binding.Service<
  ListPagesByEngagement,
  "AWS.SSMContacts.ListPagesByEngagement",
  () => Effect.Effect<
    (
      request: ssm.ListPagesByEngagementRequest,
    ) => Effect.Effect<
      ssm.ListPagesByEngagementResult,
      ssm.ListPagesByEngagementError
    >
  >
> {}
export const ListPagesByEngagement = Binding.Service<ListPagesByEngagement>(
  "AWS.SSMContacts.ListPagesByEngagement",
);
