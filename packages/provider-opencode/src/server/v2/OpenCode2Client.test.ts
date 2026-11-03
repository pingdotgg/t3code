import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_BODY = '{"version":"2.0.18","pid":4242,"urls":[],"paths":{"tmp":"/tmp"}}';

const authorizationFor = (password: string | Redacted.Redacted) => {
  const seen: Array<string | undefined> = [];
  const layerCapturing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(INFO_BODY, { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password });
    yield* client.server.info();
    return seen[0];
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
};

const utf8Basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

describe("OpenCode2Client authorization", () => {
  // OpenCode requires UTF-8 Basic auth; btoa rejects or misencodes non-ASCII.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
  );
});

// Frames captured from OpenCode 2.1.4, which no longer sends `data.recent`.
const COMPACTION_FRAMES = [
  {
    id: "evt_17fbf08bf0027kXxWvCuGCkaol",
    created: 1793144588479,
    type: "session.compaction.started",
    location: { directory: "/tmp/proj" },
    data: {
      sessionID: "ses_e80415922ffetjml4RUW7tRPQL",
      reason: "manual",
      inputID: "msg_17fbf08b10019CxokkaEaAaZ8f",
    },
    durable: { aggregateID: "ses_e80415922ffetjml4RUW7tRPQL", seq: 16, version: 1 },
  },
  {
    id: "evt_17fbf1179001YzrfiloDXDkGMV",
    created: 1793144590713,
    type: "session.compaction.ended",
    location: { directory: "/tmp/proj" },
    data: {
      sessionID: "ses_e80415922ffetjml4RUW7tRPQL",
      reason: "manual",
      model: { id: "claude-haiku-5-5", providerID: "anthropic", variant: "default" },
      text: "## Objective\n- (none)",
      tokens: { input: 4, output: 140, reasoning: 0, cache: { read: 5113, write: 10821 } },
      cost: 0.001474155,
    },
    durable: { aggregateID: "ses_e80415922ffetjml4RUW7tRPQL", seq: 18, version: 1 },
  },
];

const layerEventStream = (frames: ReadonlyArray<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    ),
  );

describe("OpenCode2Client events", () => {
  it.effect("delivers compaction events from OpenCode 2.1", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode2Client.OpenCode2Client;
      const { events } = yield* opencode.connect({
        baseUrl: "http://127.0.0.1:4096",
        password: "pw",
      });
      const received = yield* Stream.runCollect(yield* events);
      assert.deepStrictEqual(
        received.map((event) => event.type),
        ["session.compaction.started", "session.compaction.ended"],
      );
    }).pipe(
      Effect.provide(
        OpenCode2Client.layer.pipe(Layer.provide(layerEventStream(COMPACTION_FRAMES))),
      ),
    ),
  );
});
