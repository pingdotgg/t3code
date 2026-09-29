import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
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

describe("OpenCode2Client events", () => {
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
