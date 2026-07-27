import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListTopicsRequest extends sns.ListTopicsInput {}

/**
 * Runtime binding for `sns:ListTopics`.
 *
 * An account-scoped operation — bind it with no arguments to page through
 * all topic ARNs in the account/region. The binding grants the host function
 * `sns:ListTopics`. Provide the `ListTopicsHttp` layer on the Function to
 * implement the binding.
 * @binding
 * @section Listing Topics
 * @example List Topic ARNs
 * ```typescript
 * // init (provide SNS.ListTopicsHttp on the Function)
 * const listTopics = yield* SNS.ListTopics();
 *
 * // runtime: pass NextToken to page through large accounts
 * const response = yield* listTopics();
 * const arns = (response.Topics ?? []).map((topic) => topic.TopicArn);
 * ```
 */
export interface ListTopics extends Binding.Service<
  ListTopics,
  "AWS.SNS.ListTopics",
  () => Effect.Effect<
    (
      request?: ListTopicsRequest,
    ) => Effect.Effect<sns.ListTopicsResponse, sns.ListTopicsError>
  >
> {}

export const ListTopics = Binding.Service<ListTopics>("AWS.SNS.ListTopics");
