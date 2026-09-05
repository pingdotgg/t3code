import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:CreateMembers`.
 *
 * Invites accounts into the behavior graph (or auto-enables organization
 * accounts) — the automation hook for onboarding new accounts to Detective
 * as they join the fleet. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.CreateMembersHttp)`.
 * @binding
 * @section Administering Member Accounts
 * @example Invite A New Member Account
 * ```typescript
 * // init
 * const createMembers = yield* AWS.Detective.CreateMembers(graph);
 *
 * // runtime
 * yield* createMembers({
 *   Accounts: [{ AccountId: "111122223333", EmailAddress: email }],
 *   DisableEmailNotification: true,
 * });
 * ```
 */
export interface CreateMembers extends Binding.Service<
  CreateMembers,
  "AWS.Detective.CreateMembers",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.CreateMembersRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.CreateMembersResponse,
      detective.CreateMembersError
    >
  >
> {}
export const CreateMembers = Binding.Service<CreateMembers>(
  "AWS.Detective.CreateMembers",
);
