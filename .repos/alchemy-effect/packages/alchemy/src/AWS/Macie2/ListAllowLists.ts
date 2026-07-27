import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListAllowLists`.
 *
 * Retrieves a subset of information about all the allow lists for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListAllowListsHttp)`.
 * @binding
 * @section Custom Data Identifiers & Lists
 * @example List Allow Lists
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAllowLists = yield* AWS.Macie2.ListAllowLists();
 *
 * // runtime
 * const { allowLists } = yield* listAllowLists();
 * ```
 */
export interface ListAllowLists extends Binding.Service<
  ListAllowLists,
  "AWS.Macie2.ListAllowLists",
  () => Effect.Effect<
    (
      request?: macie2.ListAllowListsRequest,
    ) => Effect.Effect<
      macie2.ListAllowListsResponse,
      macie2.ListAllowListsError
    >
  >
> {}
export const ListAllowLists = Binding.Service<ListAllowLists>(
  "AWS.Macie2.ListAllowLists",
);
