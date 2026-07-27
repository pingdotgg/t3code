import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:ListMembers`.
 *
 * Lists the behavior graph's member accounts — invited and enabled alike —
 * so an admin-account function can audit coverage of the security fleet.
 * The graph ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListMembersHttp)`.
 * @binding
 * @section Administering Member Accounts
 * @example List Member Accounts
 * ```typescript
 * // init
 * const listMembers = yield* AWS.Detective.ListMembers(graph);
 *
 * // runtime
 * const { MemberDetails } = yield* listMembers();
 * ```
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.Detective.ListMembers",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<detective.ListMembersRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.ListMembersResponse,
      detective.ListMembersError
    >
  >
> {}
export const ListMembers = Binding.Service<ListMembers>(
  "AWS.Detective.ListMembers",
);
