import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DurableObjectState } from "./DurableObjectState.ts";

export type RawWebSocket = cf.WebSocket;

/**
 * An application attachment could not be encoded, decoded, read, or written.
 * Catch this tag to choose whether to fail, ignore the attachment, or close the
 * connection. Codec failures and native exceptions are preserved in `cause`.
 */
export class WebSocketAttachmentError extends Data.TaggedError(
  "WebSocketAttachmentError",
)<{
  /** The failed attachment operation, or `missing` for a nullish attachment. */
  readonly reason: "encode" | "decode" | "missing" | "read" | "write";
  /** A description of the failed operation. */
  readonly message: string;
  /** The original schema error or native exception, when present. */
  readonly cause?: unknown;
}> {}

export interface WebSocket {
  readonly ws: RawWebSocket;
  send(data: string | Uint8Array): Effect.Effect<void>;
  close(code: number, reason: string): Effect.Effect<void>;
  /**
   * Encode an application value and persist the encoded representation alongside
   * this socket. The native structured-clone and serialized-size limits apply;
   * schema validation does not guarantee that the encoded value is cloneable.
   * Requires only the codec's encoding services. Does not close the socket.
   *
   * @example
   * ```ts
   * yield* socket.setAttachment(Schema.NumberFromString, 42);
   * // The unchecked deserializeAttachment() now returns "42".
   * ```
   */
  setAttachment<S extends Schema.Constraint>(
    schema: S,
    value: NoInfer<S["Type"]>,
  ): Effect.Effect<void, WebSocketAttachmentError, S["EncodingServices"]>;
  /**
   * Read and decode an application attachment, including after hibernation.
   * A nullish native value fails with reason `missing`; other values are decoded
   * from the codec's encoded side. Requires only its decoding services.
   * No envelope or schema version is added, so unchecked attachments interoperate
   * and applications own migrations and invalid-attachment policy.
   *
   * @example
   * ```ts
   * const count = yield* socket.getAttachment(Schema.NumberFromString);
   * // count is a number, not the stored string.
   * ```
   */
  getAttachment<S extends Schema.Constraint>(
    schema: S,
  ): Effect.Effect<S["Type"], WebSocketAttachmentError, S["DecodingServices"]>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

export const fromWebSocket = (ws: RawWebSocket): WebSocket => ({
  ws,
  send: (data) => Effect.sync(() => ws.send(data as any)),
  close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
  setAttachment: (schema, value) =>
    Schema.encodeEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new WebSocketAttachmentError({
            reason: "encode",
            message: "Could not encode WebSocket attachment",
            cause,
          }),
      ),
      Effect.flatMap((encoded) =>
        Effect.try({
          try: () => ws.serializeAttachment(encoded),
          catch: (cause) =>
            new WebSocketAttachmentError({
              reason: "write",
              message: "Could not write WebSocket attachment",
              cause,
            }),
        }),
      ),
    ),
  getAttachment: (schema) =>
    Effect.try({
      try: () => ws.deserializeAttachment(),
      catch: (cause) =>
        new WebSocketAttachmentError({
          reason: "read",
          message: "Could not read WebSocket attachment",
          cause,
        }),
    }).pipe(
      Effect.flatMap((encoded) =>
        encoded === null || encoded === undefined
          ? Effect.fail(
              new WebSocketAttachmentError({
                reason: "missing",
                message: "WebSocket attachment is missing",
              }),
            )
          : Schema.decodeUnknownEffect(schema)(encoded).pipe(
              Effect.mapError(
                (cause) =>
                  new WebSocketAttachmentError({
                    reason: "decode",
                    message: "Could not decode WebSocket attachment",
                    cause,
                  }),
              ),
            ),
      ),
    ),
  serializeAttachment: (value) => ws.serializeAttachment(value),
  deserializeAttachment: () => ws.deserializeAttachment() as any,
});

// declare global {
//   const WebSocketPair: new () => [cf.WebSocket, cf.WebSocket];
// }

export const upgrade = Effect.fn(function* () {
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
