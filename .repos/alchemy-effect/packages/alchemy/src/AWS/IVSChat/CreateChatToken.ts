import type * as ivschat from "@distilled.cloud/aws/ivschat";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Room } from "./Room.ts";

/**
 * The `roomIdentifier` is injected by the binding from the bound room, and
 * the wire `sessionDurationInMinutes` is expressed as a `Duration.Input`.
 */
export interface CreateChatTokenRequest extends Omit<
  ivschat.CreateChatTokenRequest,
  "roomIdentifier" | "sessionDurationInMinutes"
> {
  /**
   * How long the issued token's chat session can remain active. Converted
   * to whole minutes on the wire (`1` - `180` minutes).
   * @default 60 minutes
   */
  sessionDuration?: Duration.Input;
}

/**
 * Mint an encrypted chat token that an end user presents to open a WebSocket
 * connection to the bound room — the effectful call made from a deployed
 * Lambda or Task. The `capabilities` field grants `SEND_MESSAGE`,
 * `DELETE_MESSAGE`, and/or `DISCONNECT_USER` to the token holder (a token
 * with no capabilities can only view chat); `attributes` attaches profile
 * data (display name, icon, …) to every message the user sends. The returned
 * `token` is sensitive and surfaces as a `Redacted` value.
 *
 * @binding
 * @section Minting Chat Tokens
 * Provide the `CreateChatTokenHttp` implementation layer on the Function
 * effect, bind the room in the init phase, then call the returned client at
 * runtime. The binding grants `ivschat:CreateChatToken` on the room and
 * injects its ARN as the `roomIdentifier` automatically.
 *
 * @example Mint a token from a Lambda
 * ```typescript
 * // init
 * const room = yield* IVSChat.Room("LiveChat");
 * const createChatToken = yield* IVSChat.CreateChatToken(room);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { token, sessionExpirationTime } = yield* createChatToken({
 *       userId: "user-123",
 *       capabilities: ["SEND_MESSAGE"],
 *       sessionDuration: "30 minutes",
 *       attributes: { displayName: "Sam" },
 *     });
 *     return HttpServerResponse.json({
 *       token: token !== undefined ? Redacted.value(token) : undefined,
 *       sessionExpirationTime,
 *     });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(IVSChat.CreateChatTokenHttp))
 * ```
 */
export interface CreateChatToken extends Binding.Service<
  CreateChatToken,
  "AWS.IVSChat.CreateChatToken",
  (
    room: Room,
  ) => Effect.Effect<
    (
      request: CreateChatTokenRequest,
    ) => Effect.Effect<
      ivschat.CreateChatTokenResponse,
      ivschat.CreateChatTokenError
    >
  >
> {}
export const CreateChatToken = Binding.Service<CreateChatToken>(
  "AWS.IVSChat.CreateChatToken",
);
