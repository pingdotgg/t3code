import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:ListEngagements`.
 *
 * List all engagements that have happened in the account, optionally
 * filtered by incident or time range.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListEngagementsHttp)`.
 * @binding
 * @section Managing Engagements
 * @example List Recent Engagements
 * ```typescript
 * const listEngagements = yield* AWS.SSMContacts.ListEngagements();
 *
 * const { Engagements } = yield* listEngagements();
 * ```
 */
export interface ListEngagements extends Binding.Service<
  ListEngagements,
  "AWS.SSMContacts.ListEngagements",
  () => Effect.Effect<
    (
      request?: ssm.ListEngagementsRequest,
    ) => Effect.Effect<ssm.ListEngagementsResult, ssm.ListEngagementsError>
  >
> {}
export const ListEngagements = Binding.Service<ListEngagements>(
  "AWS.SSMContacts.ListEngagements",
);
