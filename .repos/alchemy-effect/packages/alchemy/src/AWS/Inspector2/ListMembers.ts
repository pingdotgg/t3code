import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListMembers`.
 *
 * List members associated with the Amazon Inspector delegated administrator for your
 * organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListMembersHttp)`.
 * @binding
 * @section Organization & Members
 * @example List Member Accounts
 * ```typescript
 * // init
 * const listMembers = yield* AWS.Inspector2.ListMembers();
 *
 * // runtime
 * const { members } = yield* listMembers();
 * ```
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.Inspector2.ListMembers",
  () => Effect.Effect<
    (
      request?: inspector2.ListMembersRequest,
    ) => Effect.Effect<
      inspector2.ListMembersResponse,
      inspector2.ListMembersError
    >
  >
> {}
export const ListMembers = Binding.Service<ListMembers>(
  "AWS.Inspector2.ListMembers",
);
