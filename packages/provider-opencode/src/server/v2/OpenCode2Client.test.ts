import { assert, it } from "@effect/vitest";
import { Session } from "@opencode/client/effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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

describe("OpenCode2Client event subscription", () => {
  it.effect("times out and cancels a subscription with no response headers", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          assert.strictEqual(request.url, "http://127.0.0.1:4096/api/event");
          return Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
        }),
      );
      const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
      );
      const { events } = yield* opencode.connect({
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
      });
      const opening = yield* events.pipe(Effect.flip, Effect.forkScoped);

      yield* TestClock.adjust("10 seconds");
      assert.isTrue(yield* Deferred.isDone(cancelled));
      const error = yield* Fiber.join(opening);
      assert.strictEqual(error._tag, "HttpClientError");
      assert.strictEqual(error.reason._tag, "TransportError");
      assert.isTrue(Cause.isTimeoutError(error.cause));
    }).pipe(Effect.scoped),
  );
});

describe("OpenCode2Client execution failures", () => {
  // The bundled 2.0.28 schema strips retryAfterMs, which carries a free-tier limit's reset.
  it.effect("keeps retryAfterMs on a failed execution event", () =>
    Effect.gen(function* () {
      const frame = {
        id: "evt_failed0000",
        created: 1,
        type: "session.execution.failed",
        data: {
          sessionID: "ses_repro",
          error: {
            type: "provider.free-limit",
            message: "Free usage limit reached.",
            status: 429,
            retryAfterMs: 21_486_000,
          },
        },
        durable: { aggregateID: "ses_repro", seq: 1, version: 1 },
      };
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(`data: ${JSON.stringify(frame)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
          ),
        ),
      );
      const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
      );
      const { events } = yield* opencode.connect({
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
      });
      const first = yield* events.pipe(Effect.flatMap(Stream.runHead));
      const event = Option.getOrThrow(first);
      assert.strictEqual(event.type, "session.execution.failed");
      assert.deepEqual(
        event.type === "session.execution.failed" ? event.data.error : undefined,
        frame.data.error,
      );
    }).pipe(Effect.scoped),
  );
});

const previous = {
  id: "msg_repro088",
  type: "synthetic",
  text: "Fixture message 88",
  time: { created: 1088 },
};

const compaction = (fields: Record<string, unknown>) => ({
  type: "compaction",
  id: "msg_repro089",
  time: { created: 1089 },
  reason: "manual",
  summary: "Fixture compaction",
  ...fields,
});

const listHistory = (messages: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          assert.include(request.url, "/api/session/ses_repro/message");
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: messages, cursor: {} }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
      Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
    );
    const { client } = yield* opencode.connect({
      baseUrl: "http://127.0.0.1:4096",
      password: "test-password",
    });
    return yield* client.message.list({ sessionID: Session.ID.make("ses_repro"), order: "asc" });
  });

describe("OpenCode2Client message history", () => {
  it.effect.each([
    { status: "running", shape: "native keepID", fields: { metadata: { keepID: previous.id } } },
    { status: "completed", shape: "native keepID", fields: { metadata: { keepID: previous.id } } },
    { status: "running", shape: "native without metadata", fields: {} },
    { status: "completed", shape: "native without metadata", fields: {} },
    {
      status: "completed",
      shape: "legacy metadata",
      fields: { metadata: { recent: previous.id } },
    },
    { status: "running", shape: "top-level", fields: { recent: previous.id } },
  ] as const)("decodes a $status compaction in the $shape format", ({ status, fields }) =>
    Effect.gen(function* () {
      const history = yield* listHistory([previous, compaction({ status, ...fields })]);

      assert.deepStrictEqual(
        history.data.map((message) => message.id),
        [previous.id, "msg_repro089"],
      );
      assert.deepInclude(history.data[1], {
        type: "compaction",
        status,
        summary: "Fixture compaction",
        recent:
          "metadata" in fields && "recent" in fields.metadata ? previous.id : (fields.recent ?? ""),
      });
    }),
  );

  it.effect.each([
    { field: "recent", fields: { status: "completed", recent: 42 } },
    { field: "reason", fields: { status: "completed", reason: "scheduled", recent: previous.id } },
  ] as const)("keeps a compaction with an invalid $field an error", ({ field, fields }) =>
    Effect.gen(function* () {
      const error = yield* listHistory([compaction(fields)]).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ClientError");
      assert.isTrue(Schema.isSchemaError(error.cause));
      assert.include(String(error.cause), field);
    }),
  );
});
