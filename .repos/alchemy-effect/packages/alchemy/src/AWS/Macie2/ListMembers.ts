import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListMembers`.
 *
 * Retrieves information about the accounts that are associated with an Amazon Macie administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListMembersHttp)`.
 * @binding
 * @section Organization & Members
 * @example List Member Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listMembers = yield* AWS.Macie2.ListMembers();
 *
 * // runtime
 * const { members } = yield* listMembers();
 * ```
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.Macie2.ListMembers",
  () => Effect.Effect<
    (
      request?: macie2.ListMembersRequest,
    ) => Effect.Effect<macie2.ListMembersResponse, macie2.ListMembersError>
  >
> {}
export const ListMembers = Binding.Service<ListMembers>(
  "AWS.Macie2.ListMembers",
);
