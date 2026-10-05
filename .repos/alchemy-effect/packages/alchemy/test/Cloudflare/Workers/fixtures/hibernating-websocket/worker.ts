import { DurableObject } from "@/Cloudflare/Workers/DurableObject.ts";
import { DurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import {
  upgrade,
  type WebSocket,
  type WebSocketAttachmentError,
} from "@/Cloudflare/Workers/WebSocket.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const Attachment = Schema.Struct({
  version: Schema.Literal(1),
  count: Schema.NumberFromString,
  joined: Schema.DateFromString,
});
const Cloned = Schema.Struct({
  date: Schema.Date,
  map: Schema.ReadonlyMap(Schema.String, Schema.Number),
  bytes: Schema.Uint8Array,
});
class DecodeOffset extends Context.Service<DecodeOffset, number>()(
  "DecodeOffset",
) {}
class EncodeOffset extends Context.Service<EncodeOffset, number>()(
  "EncodeOffset",
) {}
const WithServices = Schema.NumberFromString.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value: number) =>
      DecodeOffset.pipe(Effect.map((offset) => value + offset)),
    ),
    encode: SchemaGetter.transformEffect((value: number) =>
      EncodeOffset.pipe(Effect.map((offset) => value - offset)),
    ),
  }),
);
const timestamp = "2026-01-02T03:04:05.000Z";

const failure = (error: WebSocketAttachmentError) => ({
  _tag: error._tag,
  reason: error.reason,
  cause:
    error.cause instanceof Error ? error.cause.message : String(error.cause),
  causeIsError: error.cause instanceof Error,
});

class AttachmentObject extends DurableObject<AttachmentObject>()(
  "AttachmentObject",
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      const restored: number[] = [];
      const rejected: string[] = [];
      for (const socket of yield* state.getWebSockets()) {
        yield* socket.getAttachment(Attachment).pipe(
          Effect.flatMap((value) =>
            Effect.sync(() => restored.push(value.count)),
          ),
          Effect.catchTag("WebSocketAttachmentError", (error) =>
            Effect.gen(function* () {
              rejected.push(error.reason);
              yield* socket.send(JSON.stringify({ ...failure(error), boots }));
              yield* socket.close(1008, "Invalid attachment");
            }),
          ),
        );
      }

      const handle = Effect.fn(function* (
        socket: WebSocket,
        message: string | ArrayBuffer,
      ) {
        switch (message) {
          case "codec": {
            const joined = yield* Effect.sync(() => new Date(timestamp));
            yield* socket.setAttachment(Attachment, {
              version: 1,
              count: 42,
              joined,
            });
            const encoded = yield* Effect.sync(() =>
              socket.deserializeAttachment(),
            );
            const value = yield* socket.getAttachment(Attachment);
            return {
              encoded,
              count: value.count,
              joined: value.joined.toISOString(),
              isDate: value.joined instanceof Date,
            };
          }
          case "services": {
            yield* socket
              .setAttachment(WithServices, 42)
              .pipe(Effect.provideService(EncodeOffset, 5));
            const encoded = yield* Effect.sync(() =>
              socket.deserializeAttachment(),
            );
            const decoded = yield* socket
              .getAttachment(WithServices)
              .pipe(Effect.provideService(DecodeOffset, 5));
            return { encoded, decoded };
          }
          case "unchecked": {
            yield* Effect.sync(() =>
              socket.serializeAttachment({
                version: 1,
                count: "17",
                joined: timestamp,
              }),
            );
            const value = yield* socket.getAttachment(Attachment);
            return {
              count: value.count,
              joined: value.joined.toISOString(),
              isDate: value.joined instanceof Date,
            };
          }
          case "missing": {
            const raw = yield* Effect.sync(() =>
              socket.deserializeAttachment(),
            );
            const result = yield* socket.getAttachment(Schema.Unknown).pipe(
              Effect.as({ reason: "unexpected-success" }),
              Effect.catchTag("WebSocketAttachmentError", (error) =>
                Effect.succeed(failure(error)),
              ),
            );
            return { ...result, absence: raw === null ? "null" : typeof raw };
          }
          case "malformed": {
            yield* Effect.sync(() =>
              socket.serializeAttachment({
                version: 1,
                count: 42,
                joined: timestamp,
              }),
            );
            return yield* socket.getAttachment(Attachment);
          }
          case "encode": {
            yield* socket.setAttachment(Schema.NumberFromString, 7);
            return yield* socket
              .setAttachment(
                Schema.NumberFromString.check(Schema.isGreaterThan(0)),
                -1,
              )
              .pipe(
                Effect.as({ reason: "unexpected-success" }),
                Effect.catchTag("WebSocketAttachmentError", (error) =>
                  Effect.sync(() => ({
                    ...failure(error),
                    previous: socket.deserializeAttachment(),
                  })),
                ),
              );
          }
          case "oversize": {
            yield* socket.setAttachment(Schema.String, "x".repeat(16_000));
            const acceptedLength = (yield* socket.getAttachment(Schema.String))
              .length;
            yield* socket.setAttachment(Schema.String, "small");
            return yield* socket
              .setAttachment(Schema.String, "x".repeat(32_768))
              .pipe(
                Effect.as({ reason: "unexpected-success" }),
                Effect.catchTag("WebSocketAttachmentError", (error) =>
                  Effect.sync(() => ({
                    ...failure(error),
                    acceptedLength,
                    previous: socket.deserializeAttachment(),
                  })),
                ),
              );
          }
          case "clone": {
            const value = yield* Effect.sync(() => ({
              date: new Date(timestamp),
              map: new Map([["count", 42]]),
              bytes: new Uint8Array([1, 2, 3]),
            }));
            yield* socket.setAttachment(Cloned, value);
            yield* Effect.sync(() => {
              value.date.setUTCFullYear(2000);
              value.map.set("count", 99);
              value.bytes[0] = 99;
            });
            const restored = yield* socket.getAttachment(Cloned);
            return {
              date: restored.date.toISOString(),
              count: restored.map.get("count"),
              bytes: [...restored.bytes],
            };
          }
          case "uncloneable":
            return yield* socket.setAttachment(Schema.Unknown, () => 1);
          case "obsolete":
            yield* Effect.sync(() =>
              socket.serializeAttachment({
                version: 0,
                count: "9",
                joined: timestamp,
              }),
            );
            return { boots, obsolete: true };
          case "stats": {
            const value = yield* socket.getAttachment(Attachment);
            return {
              boots,
              restored,
              rejected,
              count: value.count,
              joined: value.joined.toISOString(),
              isDate: value.joined instanceof Date,
            };
          }
          default:
            return { boots };
        }
      });
      return {
        fetch: Effect.gen(function* () {
          const [response] = yield* upgrade();
          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: WebSocket,
          message: string | ArrayBuffer,
        ) {
          const response = yield* handle(socket, message).pipe(
            Effect.catchTag("WebSocketAttachmentError", (error) =>
              Effect.succeed(failure(error)),
            ),
          );
          yield* socket.send(JSON.stringify(response));
        }),
        webSocketClose: (socket: WebSocket, code: number, reason: string) =>
          socket.close(code, reason),
      };
    });
  }),
) {}

export default class AttachmentWorker extends Worker<AttachmentWorker>()(
  "AttachmentWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* AttachmentObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/socket/")) {
          const name = request.url.split("/").pop()!;
          return yield* objects.getByName(name).fetch(request);
        }
        return HttpServerResponse.text("ready");
      }),
    };
  }),
) {}
