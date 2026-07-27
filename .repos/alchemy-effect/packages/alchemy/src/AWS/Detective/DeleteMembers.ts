import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:DeleteMembers`.
 *
 * Removes member accounts from the behavior graph — the off-boarding
 * counterpart to `CreateMembers` when an account leaves the fleet. The graph
 * ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.DeleteMembersHttp)`.
 * @binding
 * @section Administering Member Accounts
 * @example Remove A Member Account
 * ```typescript
 * // init
 * const deleteMembers = yield* AWS.Detective.DeleteMembers(graph);
 *
 * // runtime
 * yield* deleteMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DeleteMembers extends Binding.Service<
  DeleteMembers,
  "AWS.Detective.DeleteMembers",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.DeleteMembersRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.DeleteMembersResponse,
      detective.DeleteMembersError
    >
  >
> {}
export const DeleteMembers = Binding.Service<DeleteMembers>(
  "AWS.Detective.DeleteMembers",
);
