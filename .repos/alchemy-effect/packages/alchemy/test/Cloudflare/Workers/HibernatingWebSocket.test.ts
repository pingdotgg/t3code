import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import AttachmentWorker from "./fixtures/hibernating-websocket/worker.ts";

class HandshakeFailed extends Data.TaggedError("HandshakeFailed")<{
  readonly message: string;
}> {}

const connect = Effect.fn(
  function* (url: string) {
    const opened = yield* Deferred.make<void, HandshakeFailed>();
    const closed = yield* Deferred.make<{ code: number; reason: string }>();
    const messages = yield* Queue.unbounded<string>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(url.replace(/^http/, "ws"));
        socket.addEventListener("open", () =>
          Deferred.doneUnsafe(opened, Exit.void),
        );
        socket.addEventListener("error", (event) =>
          Deferred.doneUnsafe(
            opened,
            Exit.fail(
              new HandshakeFailed({
                message: `WebSocket handshake failed: ${event.type}`,
              }),
            ),
          ),
        );
        socket.addEventListener("message", (event) =>
          Queue.offerUnsafe(messages, String(event.data)),
        );
        socket.addEventListener("close", (event) =>
          Deferred.doneUnsafe(
            closed,
            Exit.succeed({ code: event.code, reason: event.reason }),
          ),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    yield* Deferred.await(opened).pipe(
      Effect.timeout("10 seconds"),
      Effect.onError(() => Effect.sync(() => socket.close())),
    );
    return {
      socket,
      send: (message: string) => Effect.sync(() => socket.send(message)),
      receive: Queue.take(messages).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)),
        ),
        Effect.timeout("10 seconds"),
      ),
      closed: Deferred.await(closed).pipe(Effect.timeout("10 seconds")),
    };
  },
  Effect.retry({
    while: (error) => error._tag === "HandshakeFailed",
    schedule: Schedule.spaced("1 second"),
    times: 8,
  }),
);

const Stats = Schema.Struct({
  boots: Schema.Number,
  restored: Schema.Array(Schema.Number),
  rejected: Schema.Array(Schema.String),
  count: Schema.Number,
  joined: Schema.String,
  isDate: Schema.Boolean,
});
const timestamp = "2026-01-02T03:04:05.000Z";

describe.concurrent.each([
  { dev: true, stage: "native-websocket-local" },
  { dev: false, stage: "native-websocket-live" },
])(
  "Native WebSocket attachments (dev: $dev)",
  ({ dev, stage }) => {
    const state = dev ? Alchemy.inMemoryState() : Cloudflare.state();
    const Stack = Alchemy.Stack(
      "HibernatingWebSocketStack",
      { providers: Cloudflare.providers(), state },
      Effect.gen(function* () {
        const worker = yield* AttachmentWorker;
        return { url: worker.url.as<string>() };
      }),
    );
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Cloudflare.providers(),
      state,
      dev,
      stage,
    });
    const stack = beforeAll(
      Effect.gen(function* () {
        yield* destroy(Stack);
        const output = yield* deploy(Stack);
        const response = yield* requestWorker(
          HttpClientRequest.get(`${output.url}/ready`),
        );
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe("ready");
        yield* connect(`${output.url}/socket/ready`).pipe(Effect.scoped);
        return output;
      }),
      { timeout: 120_000 },
    );
    afterAll(destroy(Stack), { timeout: 30_000 });

    const request = Effect.fn(function* (command: string) {
      const { url } = yield* stack;
      const connection = yield* connect(`${url}/socket/${command}`);
      yield* connection.send(command);
      const response = yield* connection.receive;
      expect(connection.socket.readyState).toBe(WebSocket.OPEN);
      yield* connection.send("codec");
      expect(yield* connection.receive).toEqual({
        encoded: { version: 1, count: "42", joined: timestamp },
        count: 42,
        joined: timestamp,
        isDate: true,
      });
      return response;
    });

    test(
      "encodes number and Date codecs and exposes the encoded value unchecked",
      Effect.gen(function* () {
        expect(yield* request("codec")).toEqual({
          encoded: { version: 1, count: "42", joined: timestamp },
          count: 42,
          joined: timestamp,
          isDate: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "uses distinct encoding and decoding services in the caller's context",
      Effect.gen(function* () {
        expect(yield* request("services")).toEqual({
          encoded: "37",
          decoded: 42,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "decodes existing unchecked attachments without an envelope",
      Effect.gen(function* () {
        expect(yield* request("unchecked")).toEqual({
          count: 17,
          joined: timestamp,
          isDate: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "reports native absence even for Schema.Unknown",
      Effect.gen(function* () {
        const response = yield* request("missing");
        yield* Effect.sync(() =>
          console.log("Native attachment absence", { dev, response }),
        );
        expect(response).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "missing",
          absence: "null",
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "returns malformed encoded values as recoverable decode errors",
      Effect.gen(function* () {
        expect(yield* request("malformed")).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "decode",
          causeIsError: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "encode failure preserves the previously written attachment",
      Effect.gen(function* () {
        expect(yield* request("encode")).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "encode",
          previous: "7",
          causeIsError: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "native oversize serialization is a recoverable write failure",
      Effect.gen(function* () {
        const response = yield* request("oversize");
        yield* Effect.sync(() =>
          console.log("Native attachment size limit", { dev, response }),
        );
        expect(response).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "write",
          acceptedLength: 16_000,
          previous: "small",
          cause:
            "A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 32774 bytes.",
          causeIsError: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "native structured clone preserves Dates, Maps, and bytes without aliasing",
      Effect.gen(function* () {
        expect(yield* request("clone")).toEqual({
          date: timestamp,
          count: 42,
          bytes: [1, 2, 3],
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "a schema-valid uncloneable value reports the genuine native error",
      Effect.gen(function* () {
        expect(yield* request("uncloneable")).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "write",
          causeIsError: true,
        });
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])] },
    );

    test(
      "real hibernation restores typed attachments and closes an obsolete schema by application policy",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const valid = yield* connect(`${url}/socket/idle`);
        yield* valid.send("codec");
        yield* valid.receive;
        yield* valid.send("stats");
        const before = yield* valid.receive.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Stats)),
        );
        const obsolete = yield* connect(`${url}/socket/idle`);
        yield* obsolete.send("obsolete");
        expect(yield* obsolete.receive).toEqual({
          boots: before.boots,
          obsolete: true,
        });
        const sameSocket = valid.socket;
        const after = yield* Effect.gen(function* () {
          yield* Effect.sleep("15 seconds");
          yield* valid.send("stats");
          return yield* valid.receive.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Stats)),
          );
        }).pipe(
          Effect.repeat({
            times: 2,
            until: (value) => value.boots > before.boots,
          }),
        );
        expect(after.boots).toBeGreaterThan(before.boots);
        expect(after.restored).toEqual([42]);
        expect(after.rejected).toEqual(["decode"]);
        expect(after.count).toBe(42);
        expect(after.joined).toBe(timestamp);
        expect(after.isDate).toBe(true);
        expect(valid.socket).toBe(sameSocket);
        expect(valid.socket.readyState).toBe(WebSocket.OPEN);
        expect(yield* obsolete.receive).toMatchObject({
          _tag: "WebSocketAttachmentError",
          reason: "decode",
          boots: after.boots,
        });
        expect(yield* obsolete.closed).toEqual({
          code: 1008,
          reason: "Invalid attachment",
        });
        expect(obsolete.socket.readyState).toBe(WebSocket.CLOSED);
        yield* valid.send("stats");
        expect(yield* valid.receive).toEqual(after);
      }).pipe(Effect.scoped),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 110_000 },
    );
  },
  { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
);
