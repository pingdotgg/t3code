import type * as ivschat from "@distilled.cloud/aws/ivschat";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Room } from "./Room.ts";

/**
 * The `roomIdentifier` is injected by the binding from the bound room;
 * the caller supplies the target message `id` and an optional `reason`.
 */
export interface DeleteMessageRequest extends Omit<
  ivschat.DeleteMessageRequest,
  "roomIdentifier"
> {}

/**
 * Moderate the bound room by deleting a message — the effectful call made
 * from a deployed Lambda or Task. It broadcasts a `DELETEMESSAGE` event to
 * every connected client, directing them to remove the message (`id` is the
 * ID from the WebSocket `SendMessage` response); an optional `reason` is
 * attached to the event.
 *
 * @binding
 * @section Moderating Messages
 * Provide the `DeleteMessageHttp` implementation layer on the Function
 * effect, bind the room in the init phase, then call the returned client at
 * runtime. The binding grants `ivschat:DeleteMessage` on the room and
 * injects its ARN as the `roomIdentifier` automatically.
 *
 * @example Delete a message from a Lambda
 * ```typescript
 * // init
 * const room = yield* IVSChat.Room("LiveChat");
 * const deleteMessage = yield* IVSChat.DeleteMessage(room);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { id } = yield* deleteMessage({
 *       id: flaggedMessageId,
 *       reason: "abusive content",
 *     });
 *     return HttpServerResponse.json({ deleted: id });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(IVSChat.DeleteMessageHttp))
 * ```
 */
export interface DeleteMessage extends Binding.Service<
  DeleteMessage,
  "AWS.IVSChat.DeleteMessage",
  (
    room: Room,
  ) => Effect.Effect<
    (
      request: DeleteMessageRequest,
    ) => Effect.Effect<
      ivschat.DeleteMessageResponse,
      ivschat.DeleteMessageError
    >
  >
> {}
export const DeleteMessage = Binding.Service<DeleteMessage>(
  "AWS.IVSChat.DeleteMessage",
);
