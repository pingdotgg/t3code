import type * as ivschat from "@distilled.cloud/aws/ivschat";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Room } from "./Room.ts";

/**
 * The `roomIdentifier` is injected by the binding from the bound room;
 * the caller supplies the event name and optional attributes.
 */
export interface SendEventRequest extends Omit<
  ivschat.SendEventRequest,
  "roomIdentifier"
> {}

/**
 * Send an application-defined event to every client connected to the bound
 * room — the effectful call made from a deployed Lambda or Task. Use it to
 * broadcast state changes (poll results, stream metadata, moderation
 * notices) alongside user chat messages; `attributes` carries the payload
 * as string key-value pairs.
 *
 * @binding
 * @section Broadcasting Events
 * Provide the `SendEventHttp` implementation layer on the Function effect,
 * bind the room in the init phase, then call the returned client at
 * runtime. The binding grants `ivschat:SendEvent` on the room and injects
 * its ARN as the `roomIdentifier` automatically.
 *
 * @example Broadcast from a Lambda
 * ```typescript
 * // init
 * const room = yield* IVSChat.Room("LiveChat");
 * const sendEvent = yield* IVSChat.SendEvent(room);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { id } = yield* sendEvent({
 *       eventName: "app:poll-result",
 *       attributes: { question: "q1", winner: "option-b" },
 *     });
 *     return HttpServerResponse.json({ id });
 *   }),
 * };
 * // on the Function effect:
 * // .pipe(Effect.provide(IVSChat.SendEventHttp))
 * ```
 */
export interface SendEvent extends Binding.Service<
  SendEvent,
  "AWS.IVSChat.SendEvent",
  (
    room: Room,
  ) => Effect.Effect<
    (
      request: SendEventRequest,
    ) => Effect.Effect<ivschat.SendEventResponse, ivschat.SendEventError>
  >
> {}
export const SendEvent = Binding.Service<SendEvent>("AWS.IVSChat.SendEvent");
