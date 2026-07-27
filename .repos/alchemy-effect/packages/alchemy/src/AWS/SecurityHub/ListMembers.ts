import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListMembers`.
 *
 * Lists the member accounts associated with this administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListMembersHttp)`.
 * @binding
 * @section Members & Organization
 * @example List Members
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listMembers = yield* AWS.SecurityHub.ListMembers();
 *
 * // runtime
 * const { Members } = yield* listMembers();
 * ```
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.SecurityHub.ListMembers",
  () => Effect.Effect<
    (
      request?: securityhub.ListMembersRequest,
    ) => Effect.Effect<
      securityhub.ListMembersResponse,
      securityhub.ListMembersError
    >
  >
> {}
export const ListMembers = Binding.Service<ListMembers>(
  "AWS.SecurityHub.ListMembers",
);
