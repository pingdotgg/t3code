import { assert, it } from "@effect/vitest";
import { Session } from "@opencode/client/effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as UrlParams from "effect/http/UrlParams";
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
  }),
);

describe("OpenCode2Client native image jobs", () => {
  it.effect.each([
    { path: "/work/image.png", location: "/work" },
    { path: "/tmp/images/session/image.png", location: "/tmp/images/session" },
  ])("reads remote image $path through its native filesystem location", ({ path, location }) =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.url, "http://remote.test/api/fs/read/image.png");
          assert.deepEqual(UrlParams.toRecord(request.urlParams), {
            "location[directory]": location,
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(Buffer.from("iVBORw0KGgo=", "base64")),
          );
        }),
      );
      const service = yield* OpenCode2Client.make.pipe(
        Effect.provideService(HttpClient.HttpClient, transport),
      );
      const api = yield* service.connect({ baseUrl: "http://remote.test", password: "secret" });
      assert.deepEqual(yield* api.readImage(path, "/work"), {
        uri: "data:image/png;base64,iVBORw0KGgo=",
        mime: "image/png",
      });
    }),
  );

  it.effect("rejects remote previews above the shared image limit", () =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new Uint8Array(11 * 1024 * 1024))),
        ),
      );
      const service = yield* OpenCode2Client.make.pipe(
        Effect.provideService(HttpClient.HttpClient, transport),
      );
      const api = yield* service.connect({ baseUrl: "http://remote.test", password: "secret" });
      const result = yield* api.readImage("/work/image.png", "/work").pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("reads scoped image jobs without accepting other sessions or job kinds", () =>
    Effect.gen(function* () {
      const job = {
        kind: "image",
        id: "image_test",
        sessionID: "ses_owner",
        status: "running",
        path: "/work/image",
        model: "test/image",
      } as const;
      const transport = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.headers.authorization, utf8Basic("secret"));
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                job,
                { ...job, sessionID: "ses_other" },
                { ...job, kind: "shell" },
                { ...job, status: "future" },
              ],
            }),
          );
        }),
      );
      const service = yield* OpenCode2Client.make.pipe(
        Effect.provideService(HttpClient.HttpClient, transport),
      );
      const api = yield* service.connect({ baseUrl: "http://remote.test", password: "secret" });
      assert.deepEqual(yield* api.imageJobs("ses_owner"), [job]);
    }),
  );
});

describe("OpenCode2Client usage limits", () => {
  it.effect("reads the connected workspace and maps Go and Console budgets", () =>
    Effect.gen(function* () {
      let workspace = "wrk_remote";
      let usageURL: string | undefined;
      const transport = HttpClient.make((request) => {
        assert.strictEqual(request.headers.authorization, utf8Basic("remote-password"));
        assert.deepStrictEqual(Array.from(request.urlParams), [
          ["location[directory]", "/remote/project"],
        ]);
        if (request.url === "https://remote.example/prefix/api/provider")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  { id: "opencode", integrationID: "opencode" },
                  { id: "console-custom", integrationID: "opencode" },
                  { id: "opencode-go", integrationID: "opencode" },
                  { id: "anthropic", integrationID: "anthropic" },
                  { id: "byok" },
                ],
              }),
            ),
          );
        assert.strictEqual(
          request.url,
          "https://remote.example/prefix/api/experimental/usage/limits",
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              location: { directory: "/remote/project" },
              data: {
                workspace: {
                  id: workspace,
                  name: workspace,
                  usageURL: usageURL ?? "https://opencode.ai/console/" + workspace,
                },
                go: {
                  rolling: { percent: 23, limited: false, resetsAt: 1793491200000 },
                  weekly: { percent: 99, limited: true, resetsAt: 1793491200000 },
                  monthly: { percent: 12, limited: false, resetsAt: 1793491200000 },
                },
                budgets: [
                  {
                    id: "all",
                    limit: 20,
                    spent: 15,
                    scope: "combined",
                    per: "set",
                    coverage: "all",
                    models: [],
                    vendors: [],
                    picked: false,
                    shared: true,
                    resetsAt: 1793491200000,
                  },
                  {
                    id: "models",
                    limit: 10,
                    spent: 12,
                    scope: "each",
                    per: "model",
                    coverage: "models",
                    models: [
                      { providerID: "opencode", modelID: "a", name: "Model A", spent: 12 },
                      { providerID: "opencode", modelID: "b", name: "Model B", spent: 2 },
                    ],
                    vendors: [],
                    picked: true,
                    shared: false,
                    resetsAt: 1793491200000,
                  },
                  {
                    id: "zz_missing",
                    limit: 10,
                    spent: 10,
                    scope: "each",
                    per: "model",
                    coverage: "models",
                    models: [{ providerID: "opencode", modelID: "unknown", name: "Unknown spend" }],
                    shared: false,
                    resetsAt: 1793491200000,
                  },
                  {
                    id: "zero",
                    limit: 0,
                    spent: 0,
                    scope: "each",
                    per: "set",
                    coverage: "all",
                    models: [],
                    vendors: [],
                    picked: false,
                    shared: false,
                    resetsAt: 1793491200000,
                  },
                ],
              },
            }),
          ),
        );
      });
      const opencode = yield* OpenCode2Client.make.pipe(
        Effect.provideService(HttpClient.HttpClient, transport),
      );
      const api = yield* opencode.connect({
        baseUrl: "https://remote.example/prefix",
        password: "remote-password",
      });
      const first = yield* api.usageLimits("/remote/project");
      assert.isDefined(first);
      assert.deepStrictEqual(
        first?.windows.map((window) => window.usedPercent),
        [23, 100, 12, 75, 100, 20, 100, 100],
      );
      assert.isTrue(
        first?.windows.every((window) => window.resetsAt === "2026-11-01T00:00:00.000Z"),
      );
      assert.include(first?.windows[3]?.label ?? "", "Shared");
      assert.include(first?.windows[4]?.label ?? "", "Model A");
      assert.deepStrictEqual(first?.windows[4]?.modelIds, ["opencode/a"]);
      assert.strictEqual(first?.windows[3]?.modelIds, undefined);
      assert.deepStrictEqual(first?.windows[3]?.providerIds, ["opencode", "console-custom"]);
      assert.deepStrictEqual(first?.windows[7]?.modelIds, []);
      assert.include(first?.windows[7]?.label ?? "", "Most used model");
      assert.strictEqual(first?.credentialFingerprint, undefined);
      workspace = "wrk_switched";
      const next = yield* api.usageLimits("/remote/project");
      assert.strictEqual(next?.externalUsage?.label, "wrk_switched");
      assert.strictEqual(next?.externalUsage?.url, "https://opencode.ai/console/wrk_switched");
      for (const url of [
        "not a URL",
        "javascript:alert(1)",
        "custom-app://usage",
        "file:///tmp/usage",
      ]) {
        usageURL = url;
        const invalid = yield* api.usageLimits("/remote/project");
        assert.strictEqual(invalid?.externalUsage, undefined);
        assert.deepStrictEqual(invalid?.windows, next?.windows);
      }
      usageURL = "http://console.example/workspace/usage";
      assert.strictEqual((yield* api.usageLimits("/remote/project"))?.externalUsage?.url, usageURL);
    }),
  );

  it.effect("recognizes an older server's SPA fallback", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode2Client.make.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("<!doctype html><title>OpenCode</title>", {
                  headers: { "content-type": "text/html; charset=utf-8" },
                }),
              ),
            ),
          ),
        ),
      );
      const api = yield* opencode.connect({ baseUrl: "https://old.example", password: "secret" });
      assert.strictEqual(yield* api.usageLimits("/remote"), undefined);
    }),
  );

  it.effect("distinguishes missing endpoints, signed out, and failed remote probes", () =>
    Effect.gen(function* () {
      for (const [status, body, reason] of [
        [404, {}, undefined],
        [405, {}, undefined],
        [200, { location: { directory: "/remote" }, data: null }, "unsupported"],
        [503, {}, "probeFailed"],
        [401, {}, "probeFailed"],
        [200, { data: { workspace: {} } }, "probeFailed"],
      ] as const) {
        const opencode = yield* OpenCode2Client.make.pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
            ),
          ),
        );
        const api = yield* opencode.connect({
          baseUrl: "https://remote.example",
          password: "secret",
        });
        const result = yield* api.usageLimits("/remote");
        if (reason === undefined) assert.strictEqual(result, undefined);
        else assert.strictEqual(result?.unavailable?.reason, reason);
        if (status === 200 && reason === "unsupported")
          assert.include(result?.unavailable?.message ?? "", "signed in");
      }
    }),
  );
});
