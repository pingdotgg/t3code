import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:GetMembers`.
 *
 * Reads the membership details of specific accounts in the behavior graph —
 * status, volume usage, and per-package ingest states. Unknown accounts come
 * back in `UnprocessedAccounts`. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.GetMembersHttp)`.
 * @binding
 * @section Administering Member Accounts
 * @example Check A Member's Status
 * ```typescript
 * // init
 * const getMembers = yield* AWS.Detective.GetMembers(graph);
 *
 * // runtime
 * const { MemberDetails } = yield* getMembers({
 *   AccountIds: ["111122223333"],
 * });
 * ```
 */
export interface GetMembers extends Binding.Service<
  GetMembers,
  "AWS.Detective.GetMembers",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.GetMembersRequest, "GraphArn">,
    ) => Effect.Effect<detective.GetMembersResponse, detective.GetMembersError>
  >
> {}
export const GetMembers = Binding.Service<GetMembers>(
  "AWS.Detective.GetMembers",
);
