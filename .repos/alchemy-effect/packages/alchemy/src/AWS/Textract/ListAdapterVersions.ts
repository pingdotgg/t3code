import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Runtime binding for `textract:ListAdapterVersions` — list the versions
 * of the bound adapter and their training status.
 *
 * @binding
 * @section Managing Adapters
 * @example List Adapter Versions
 * ```typescript
 * // init
 * const listAdapterVersions = yield* AWS.Textract.ListAdapterVersions(adapter);
 *
 * // runtime
 * const result = yield* listAdapterVersions();
 * const versions = result.AdapterVersions;
 * ```
 */
export interface ListAdapterVersions extends Binding.Service<
  ListAdapterVersions,
  "AWS.Textract.ListAdapterVersions",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    (
      request?: Omit<textract.ListAdapterVersionsRequest, "AdapterId">,
    ) => Effect.Effect<
      textract.ListAdapterVersionsResponse,
      textract.ListAdapterVersionsError
    >
  >
> {}
export const ListAdapterVersions = Binding.Service<ListAdapterVersions>(
  "AWS.Textract.ListAdapterVersions",
);
