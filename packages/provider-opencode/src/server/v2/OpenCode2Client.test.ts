import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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

it.effect("closes an event subscription that recovery has not started reading", () =>
  Effect.gen(function* () {
    const signals: Array<AbortSignal> = [];
    const http = HttpClient.make((request, _url, signal) =>
      Effect.sync(() => {
        signals.push(signal);
        return HttpClientResponse.fromWeb(
          request,
          new Response(": connected\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }),
    );
    const opencode = yield* OpenCode2Client.make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const connection = yield* opencode.connect({
      baseUrl: "http://127.0.0.1:4096",
      password: "test",
    });
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    yield* connection.events.pipe(Effect.provideService(Scope.Scope, scope), Effect.asVoid);
    assert.isFalse(signals[0]!.aborted);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(signals[0]!.aborted);
  }).pipe(Effect.scoped),
);
