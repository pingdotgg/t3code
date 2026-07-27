import type * as ivschat from "@distilled.cloud/aws/ivschat";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Room } from "./Room.ts";

/**
 * The `roomIdentifier` is injected by the binding from the bound room;
 * the caller supplies the target `userId` (accepted as a plain string or a
 * `Redacted` value) and an optional `reason`.
 */
export interface DisconnectUserRequest extends Omit<
  ivschat.DisconnectUserRequest,
  "roomIdentifier"
> {}

/**
 * Moderate the bound room by disconnecting all WebSocket connections of a
 * user — the effectful call made from a deployed Lambda or Task. The
 * `userId` is the one the user's chat token was minted with; disconnection
 * does not prevent reconnection, so revoke by not minting further tokens.
 * The call succeeds even when the user has no open connections.
 *
 * @binding
 * @section Moderating Users
 * Provide the `DisconnectUserHttp` implementation layer on the Function
 * effect, bind the room in the init phase, then call the returned client at
 * runtime. The binding grants `ivschat:DisconnectUser` on the room and
 * injects its ARN as the `roomIdentifier` automatically.
 *
 * @example Disconnect a user from a Lambda
 * ```typescript
 * // init
 * const room = yield* IVSChat.Room("LiveChat");
 * const disconnectUser = yield* IVSChat.DisconnectUser(room);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* disconnectUser({ userId: "user-123", reason: "spam" });
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(IVSChat.DisconnectUserHttp))
 * ```
 */
export interface DisconnectUser extends Binding.Service<
  DisconnectUser,
  "AWS.IVSChat.DisconnectUser",
  (
    room: Room,
  ) => Effect.Effect<
    (
      request: DisconnectUserRequest,
    ) => Effect.Effect<
      ivschat.DisconnectUserResponse,
      ivschat.DisconnectUserError
    >
  >
> {}
export const DisconnectUser = Binding.Service<DisconnectUser>(
  "AWS.IVSChat.DisconnectUser",
);
