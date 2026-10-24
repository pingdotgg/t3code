import { assert, it } from "@effect/vitest";
import { Session } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
  // OpenCode decodes Basic credentials as UTF-8. Latin-1 (`btoa`) encoding gets
  // `pässwörd` rejected with a 401 and throws on characters such as `€`.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
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
