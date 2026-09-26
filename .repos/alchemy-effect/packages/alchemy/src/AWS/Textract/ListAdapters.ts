import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:ListAdapters` — list the Textract
 * adapters in the account/region.
 *
 * ### Managing Adapters
 * **Example:** List Adapters
 * ```typescript
 * // init
 * const listAdapters = yield* AWS.Textract.ListAdapters();
 *
 * // runtime
 * const result = yield* listAdapters();
 * const names = (result.Adapters ?? []).map((a) => a.AdapterName);
 * ```
 *
 * @binding
 */
export interface ListAdapters extends Binding.Service<
  ListAdapters,
  "AWS.Textract.ListAdapters",
  () => Effect.Effect<
    (
      request?: textract.ListAdaptersRequest,
    ) => Effect.Effect<
      textract.ListAdaptersResponse,
      textract.ListAdaptersError
    >
  >
> {}
export const ListAdapters = Binding.Service<ListAdapters>(
  "AWS.Textract.ListAdapters",
);
