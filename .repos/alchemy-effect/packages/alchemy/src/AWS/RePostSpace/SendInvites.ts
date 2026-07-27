import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface SendInvitesRequest extends Omit<
  repostspace.SendInvitesInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `SendInvites` operation (IAM action
 * `repostspace:SendInvites` on the space ARN).
 *
 * Sends invitation emails (with a custom title and body) to users or
 * groups of the bound {@link Space}, identified by their IAM Identity
 * Center accessor ids.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.SendInvitesHttp)`.
 * @binding
 * @section Inviting Users
 * @example Invite users to the private re:Post
 * ```typescript
 * const sendInvites = yield* AWS.RePostSpace.SendInvites(space);
 *
 * yield* sendInvites({
 *   accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
 *   title: "Join our internal re:Post",
 *   body: "Ask and answer questions about our AWS workloads.",
 * });
 * ```
 */
export interface SendInvites extends Binding.Service<
  SendInvites,
  "AWS.RePostSpace.SendInvites",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: SendInvitesRequest,
    ) => Effect.Effect<
      repostspace.SendInvitesResponse,
      repostspace.SendInvitesError
    >
  >
> {}
export const SendInvites = Binding.Service<SendInvites>(
  "AWS.RePostSpace.SendInvites",
);
