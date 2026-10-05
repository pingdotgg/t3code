import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const RECORDING = new URL(
  "../../orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson",
  import.meta.url,
);
const Entry = Schema.Struct({ type: Schema.String, frame: Schema.optional(Schema.Unknown) });
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The recorded `simple` turn's events, as a newer server would send them. */
const newerServerStream = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const recorded = (yield* fs.readFileString(RECORDING.pathname))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeEntry(line))
    .flatMap((entry) => {
      const frame = entry.frame as { readonly type?: string; readonly event?: unknown } | undefined;
      return frame?.type === "sdk.event" ? [frame.event as Record<string, unknown>] : [];
    });
  const executionStarted = recorded.findIndex(
    (event) => event.type === "session.execution.started",
  );
  const [first] = recorded;
  return [
    ...recorded.slice(0, executionStarted),
    // An event type this build has never heard of.
    {
      id: "evt_0000000000newtype",
      created: 1,
      type: "session.hologram.projected",
      data: { beams: 3 },
    },
    // A known event carrying a field added after 2.0.18.
    {
      ...recorded[executionStarted],
      data: { ...(recorded[executionStarted]!.data as object), lane: "fast" },
    },
    ...recorded.slice(executionStarted + 1),
    first,
  ];
});

const serving = (events: ReadonlyArray<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    ),
  );

const connect = Effect.gen(function* () {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  return yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password: "secret" });
});

/** Sends `events`, then keeps the connection open without another byte, like a frozen server. */
const servingThenSilent = (events: ReadonlyArray<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const event of events) {
                  controller.enqueue(new TextEncoder().encode(`data: ${encodeJson(event)}\n\n`));
                }
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    ),
  );

describe("OpenCode2Client events", () => {
  it.effect("fails a stream that stops sending anything, even heartbeats", () =>
    Effect.gen(function* () {
      const { events } = yield* connect.pipe(
        Effect.provide(
          OpenCode2Client.layer.pipe(
            Layer.provide(servingThenSilent([{ id: "evt_1", type: "server.connected", data: {} }])),
          ),
        ),
      );
      const drained = yield* (yield* events).pipe(Stream.runDrain, Effect.flip, Effect.forkChild);
      // Let the first frame arrive and the timer start before the clock moves.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("46 seconds");
      const failure = yield* Fiber.join(drained);
      assert.strictEqual(failure._tag, "OpenCode2SilentStreamError");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps an execution's end and start it cannot decode, and skips other unknown events",
    () =>
      Effect.gen(function* () {
        const { events } = yield* connect.pipe(
          Effect.provide(
            OpenCode2Client.layer.pipe(
              Layer.provide(
                serving([
                  {
                    id: "evt_1",
                    created: 1,
                    type: "session.hologram.projected",
                    data: { sessionID: "ses_x" },
                  },
                  // A start is kept as a marker; it never ends anything.
                  {
                    id: "evt_0",
                    created: 1,
                    type: "session.execution.started",
                    data: { sessionID: "ses_x", lane: 7 },
                    durable: "not-an-envelope",
                  },
                  {
                    id: "evt_2",
                    created: 1,
                    type: "session.execution.interrupted",
                    data: { sessionID: "ses_x", reason: "budget" },
                    durable: { aggregateID: "ses_x", seq: 1, version: 1 },
                  },
                ]),
              ),
            ),
          ),
        );
        const received = yield* (yield* events).pipe(Stream.runCollect);
        assert.deepStrictEqual(received, [
          { type: "unreadable.execution.started", sessionID: "ses_x" },
          {
            type: "unreadable.execution.ended",
            executionType: "session.execution.interrupted",
            sessionID: "ses_x",
          },
        ]);
      }),
  );

  it.effect("skips events a newer server adds and still sees the turn end", () =>
    Effect.gen(function* () {
      const events = yield* newerServerStream;
      const { events: subscribe } = yield* connect.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(serving(events)))),
      );
      const types = yield* (yield* subscribe).pipe(
        Stream.map((event) => event.type),
        Stream.runCollect,
      );

      assert.notInclude(types, "session.hologram.projected");
      assert.include(types, "session.execution.started");
      assert.include(types, "session.execution.succeeded");
      assert.strictEqual(types.length, events.length - 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the client's own subscription fails the whole stream on the same events", () =>
    Effect.gen(function* () {
      const events = yield* newerServerStream;
      const { client } = yield* connect.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(serving(events)))),
      );
      const failure = yield* client.event.subscribe().pipe(Stream.runDrain, Effect.flip);
      assert.strictEqual(failure._tag, "ClientError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
