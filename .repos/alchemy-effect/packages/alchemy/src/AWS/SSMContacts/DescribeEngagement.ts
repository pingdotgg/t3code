import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:DescribeEngagement`.
 *
 * Read the details of an engagement — sender, subject, content, and the
 * incident it belongs to.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.DescribeEngagementHttp)`.
 * @binding
 * @section Managing Engagements
 * @example Inspect an Engagement
 * ```typescript
 * const describeEngagement = yield* AWS.SSMContacts.DescribeEngagement();
 *
 * const engagement = yield* describeEngagement({ EngagementId: engagementArn });
 * // engagement.Subject, engagement.ContactArn, ...
 * ```
 */
export interface DescribeEngagement extends Binding.Service<
  DescribeEngagement,
  "AWS.SSMContacts.DescribeEngagement",
  () => Effect.Effect<
    (
      request: ssm.DescribeEngagementRequest,
    ) => Effect.Effect<
      ssm.DescribeEngagementResult,
      ssm.DescribeEngagementError
    >
  >
> {}
export const DescribeEngagement = Binding.Service<DescribeEngagement>(
  "AWS.SSMContacts.DescribeEngagement",
);
