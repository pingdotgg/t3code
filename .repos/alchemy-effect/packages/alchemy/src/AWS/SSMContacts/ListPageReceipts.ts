import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-contacts:ListPageReceipts`.
 *
 * List the delivery/read receipts of a page — one receipt per contact
 * channel the page was sent over.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListPageReceiptsHttp)`.
 * ### Working with Pages
 * **Example:** Check Whether a Page Was Read
 * ```typescript
 * const listPageReceipts = yield* AWS.SSMContacts.ListPageReceipts();
 *
 * const { Receipts } = yield* listPageReceipts({ PageId: pageArn });
 * // receipts with ReceiptType "READ" mean the page was acknowledged
 * ```
 *
 * @binding
 */
export interface ListPageReceipts extends Binding.Service<
  ListPageReceipts,
  "AWS.SSMContacts.ListPageReceipts",
  () => Effect.Effect<
    (
      request: ssm.ListPageReceiptsRequest,
    ) => Effect.Effect<ssm.ListPageReceiptsResult, ssm.ListPageReceiptsError>
  >
> {}
export const ListPageReceipts = Binding.Service<ListPageReceipts>(
  "AWS.SSMContacts.ListPageReceipts",
);
