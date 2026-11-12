import type * as Effect from "effect/Effect";

/** A WebSocket client for a chat room (the test's side of the conversation). */
export interface Socket {
  send(text: string): Effect.Effect<void>;
  readonly receive: Effect.Effect<string>;
}

export declare const connect: (url: string) => Effect.Effect<Socket>;

/** A room's archived messages, waiting until the queue has delivered them. */
export declare const history: (url: string, room: string) => Effect.Effect<string[]>;
