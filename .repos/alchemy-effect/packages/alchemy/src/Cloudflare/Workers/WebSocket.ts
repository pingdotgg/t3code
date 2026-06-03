import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DurableObjectState } from "./DurableObjectState.ts";

export type RawWebSocket = cf.WebSocket;

export interface DurableWebSocket {
  readonly ws: RawWebSocket;
  send(data: string | Uint8Array): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

export const fromWebSocket = (ws: RawWebSocket): DurableWebSocket => ({
  ws,
  send: (data) => Effect.sync(() => ws.send(data as any)),
  close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
  serializeAttachment: (value) => ws.serializeAttachment(value),
  deserializeAttachment: () => ws.deserializeAttachment() as any,
});

// declare global {
//   const WebSocketPair: new () => [cf.WebSocket, cf.WebSocket];
// }

export const upgrade = Effect.fnUntraced(function* () {
  const _Response = Response as any as typeof cf.Response;
  const ctx = yield* DurableObjectState;
  // @ts-expect-error
  const [client, server] = new WebSocketPair();
  const serverSocket = fromWebSocket(server);
  yield* ctx.acceptWebSocket(serverSocket);
  const rawResponse = new _Response(null, {
    status: 101,
    webSocket: client,
  });
  const effectResponse = HttpServerResponse.setBody(
    HttpServerResponse.empty({ status: 101 }),
    HttpBody.raw(rawResponse),
  );
  return [effectResponse, serverSocket] as const;
});
