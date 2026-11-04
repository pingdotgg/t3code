import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `ssm-contacts:DescribeEngagement`.
 *
 * Read the details of an engagement — sender, subject, content, and the
 * incident it belongs to.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.DescribeEngagementHttp)`.
 * ### Managing Engagements
 * **Example:** Inspect an Engagement
 * ```typescript
 * const describeEngagement = yield* AWS.SSMContacts.DescribeEngagement();
 *
 * const engagement = yield* describeEngagement({ EngagementId: engagementArn });
 * // engagement.Subject, engagement.ContactArn, ...
 * ```
 *
 * @binding
 */
export interface DescribeEngagement extends Binding.Service<
  DescribeEngagement,
  "AWS.SSMContacts.DescribeEngagement",
  () => Effect.Effect<
    (
      request: ssm.DescribeEngagementRequest,
    ) => Effect.Effect<ssm.DescribeEngagementResult, ssm.DescribeEngagementError>
  >
> {}
export const DescribeEngagement = Binding.Service<DescribeEngagement>(
  "AWS.SSMContacts.DescribeEngagement",
);
