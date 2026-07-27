import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  fromDurableObjectStorage,
  type DurableObjectStorage,
} from "./DurableObjectStorage.ts";
import { fromWebSocket, type WebSocket } from "./WebSocket.ts";

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  {
    readonly id: cf.DurableObjectId;
    readonly storage: DurableObjectStorage;
    container?: cf.Container;
    /**
     * Run an Effect in the background without blocking the current event,
     * keeping the Durable Object alive until it settles. The Effect runs with
     * the caller's full context (services, tracing), and the resulting
     * promise is registered with workerd's `state.waitUntil`.
     */
    waitUntil<A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R | RuntimeContext>;
    /**
     * The raw workerd DurableObjectState, for interop with async APIs.
     */
    readonly raw: cf.DurableObjectState;
    blockConcurrencyWhile<T>(
      callback: () => Effect.Effect<T, never, RuntimeContext>,
    ): Effect.Effect<T, never, RuntimeContext>;
    acceptWebSocket(
      ws: WebSocket,
      tags?: string[],
    ): Effect.Effect<void, never, RuntimeContext>;
    getWebSockets(
      tag?: string,
    ): Effect.Effect<WebSocket[], never, RuntimeContext>;
    setWebSocketAutoResponse(
      maybeReqResp?: cf.WebSocketRequestResponsePair,
    ): Effect.Effect<void, never, RuntimeContext>;
    getWebSocketAutoResponse(): Effect.Effect<
      cf.WebSocketRequestResponsePair | null,
      never,
      RuntimeContext
    >;
    getWebSocketAutoResponseTimestamp(
      ws: cf.WebSocket,
    ): Effect.Effect<Date | null, never, RuntimeContext>;
    setHibernatableWebSocketEventTimeout(
      timeoutMs?: number,
    ): Effect.Effect<void, never, RuntimeContext>;
    getHibernatableWebSocketEventTimeout(): Effect.Effect<
      number | null,
      never,
      RuntimeContext
    >;
    getTags(ws: cf.WebSocket): Effect.Effect<string[], never, RuntimeContext>;
    abort(reason?: string): Effect.Effect<void, never, RuntimeContext>;
  }
>()("Cloudflare.DurableObjectState") {}

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectState["Service"] => ({
  id: state.id,
  container: state.container,
  storage: fromDurableObjectStorage(state.storage),
  raw: state,
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // Register the promise with workerd un-awaited — waitUntil extends the
      // event's lifetime without blocking the caller.
      yield* Effect.sync(() =>
        state.waitUntil(
          Effect.runPromise(effect.pipe(Effect.provide(context))),
        ),
      );
    }),
  blockConcurrencyWhile: <T>(callback: () => Effect.Effect<T>) =>
    Effect.tryPromise(() =>
      state.blockConcurrencyWhile(() => Effect.runPromise(callback())),
    ),
  acceptWebSocket: (ws: WebSocket, tags?: string[]) =>
    Effect.sync(() => state.acceptWebSocket(ws.ws, tags)),
  getWebSockets: (tag?: string) =>
    Effect.sync(() => state.getWebSockets(tag).map(fromWebSocket)),
  setWebSocketAutoResponse: (maybeReqResp?: cf.WebSocketRequestResponsePair) =>
    Effect.sync(() => state.setWebSocketAutoResponse(maybeReqResp)),
  getWebSocketAutoResponse: () =>
    Effect.sync(() => state.getWebSocketAutoResponse()),
  getWebSocketAutoResponseTimestamp: (ws: cf.WebSocket) =>
    Effect.sync(() => state.getWebSocketAutoResponseTimestamp(ws)),
  setHibernatableWebSocketEventTimeout: (timeoutMs?: number) =>
    Effect.sync(() => state.setHibernatableWebSocketEventTimeout(timeoutMs)),
  getHibernatableWebSocketEventTimeout: () =>
    Effect.sync(() => state.getHibernatableWebSocketEventTimeout()),
  getTags: (ws: cf.WebSocket) => Effect.sync(() => state.getTags(ws)),
  abort: (reason?: string) => Effect.sync(() => state.abort(reason)),
});
