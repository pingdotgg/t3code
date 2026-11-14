import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `ssm-contacts:DescribePage`.
 *
 * Read the details of a page — the engagement it belongs to, its subject
 * and content, and delivery/read timestamps.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.DescribePageHttp)`.
 * ### Working with Pages
 * **Example:** Inspect a Page
 * ```typescript
 * const describePage = yield* AWS.SSMContacts.DescribePage();
 *
 * const page = yield* describePage({ PageId: pageArn });
 * // page.SentTime, page.ReadTime, page.DeliveryTime, ...
 * ```
 *
 * @binding
 */
export interface DescribePage extends Binding.Service<
  DescribePage,
  "AWS.SSMContacts.DescribePage",
  () => Effect.Effect<
    (
      request: ssm.DescribePageRequest,
    ) => Effect.Effect<ssm.DescribePageResult, ssm.DescribePageError>
  >
> {}
export const DescribePage = Binding.Service<DescribePage>("AWS.SSMContacts.DescribePage");
