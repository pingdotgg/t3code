import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as HttpHeaders from "effect/unstable/http/Headers";
import { describe } from "vite-plus/test";

import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as OpenCodeServerLedger from "../OpenCodeServerLedger.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

// Shapes and content types observed on `opencode serve` 2.0.18 (pid and port replaced). 1.x
// answers /api/info with its web UI: 200 text/html.
const INFO_BODY =
  '{"version":"2.0.18","pid":4242,"urls":["http://127.0.0.1:4096"],"paths":{"tmp":"/tmp/opencode"}}';
const UNAUTHORIZED_BODY = '{"_tag":"UnauthorizedError","message":"Authentication required"}';
const SPA_BODY = "<!doctype html><html><head><title>OpenCode</title></head></html>";

const serverReplying = (reply: {
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
}) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: reply.contentType === undefined ? {} : { "content-type": reply.contentType },
          }),
        ),
      ),
    ),
  );

const verify = (httpClient: Layer.Layer<HttpClient.HttpClient>, url = "http://127.0.0.1:4096") =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: url, password: "secret" });
    return yield* OpenCode2Server.verifyServer(client);
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(httpClient))));

describe("OpenCode2Server.verifyServer", () => {
  it.effect("returns the version of an authenticated OpenCode 2 server", () =>
    Effect.gen(function* () {
      const version = yield* verify(
        serverReplying({ status: 200, contentType: "application/json", body: INFO_BODY }),
      );
      assert.strictEqual(version, "2.0.18");
    }),
  );

  it.effect("reports a rejected password, not a wrong server", () =>
    Effect.gen(function* () {
      const error = yield* verify(
        serverReplying({ status: 401, contentType: "application/json", body: UNAUTHORIZED_BODY }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "rejected the server password");
    }),
  );

  // 1.x rejects a wrong password with an empty 401, which the client cannot decode.
  it.effect("reports an empty-body 401 as a rejected password", () =>
    Effect.gen(function* () {
      const error = yield* verify(serverReplying({ status: 401, body: "" })).pipe(Effect.flip);
      assert.include(error.detail, "rejected the server password");
    }),
  );

  it.effect("reports a server error as a server error, not as unreachable", () =>
    Effect.gen(function* () {
      for (const status of [500, 502]) {
        const error = yield* verify(
          serverReplying({ status, contentType: "text/plain", body: "upstream failed" }),
        ).pipe(Effect.flip);
        assert.include(error.detail, `returned HTTP ${status}`);
      }
    }),
  );

  // 1.x (and the 2.x web UI on unknown paths) answers /api/info with 200 HTML.
  it.effect("rejects a server that answers with the web UI's HTML", () =>
    Effect.gen(function* () {
      const error = yield* verify(
        serverReplying({ status: 200, contentType: "text/html", body: SPA_BODY }),
      ).pipe(Effect.flip);
      assert.include(error.detail, "is not an OpenCode 2 server");
    }),
  );

  it.effect("reports an unreachable server as unreachable", () =>
    Effect.gen(function* () {
      const error = yield* verify(FetchHttpClient.layer, "http://127.0.0.1:1").pipe(Effect.flip);
      assert.include(error.detail, "Could not reach the OpenCode server");
    }),
  );
});

describe("OpenCode2Server error details", () => {
  // `detail` reaches clients through the provider status message, and a
  // `serverUrl` can carry credentials in its userinfo or query.
  const serverUrl = "http://user:url-secret@127.0.0.1:1/?token=query-secret";
  const detailFor = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
    Effect.gen(function* () {
      const server = yield* OpenCode2Server.make({
        binaryPath: "opencode",
        serverUrl,
        serverPassword: "secret",
        directory: "/project",
        environment: {},
      });
      const error = yield* server.withConnection(() => Effect.void).pipe(Effect.flip);
      return error.detail;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          OpenCode2Client.layer.pipe(Layer.provide(httpClient)),
          OpenCodeRuntime.OpenCodeRuntimeLive.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  it.effect("never include the server URL", () =>
    Effect.gen(function* () {
      const hanging = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      );
      const timedOut = yield* detailFor(hanging).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const details = [
        yield* detailFor(FetchHttpClient.layer),
        yield* detailFor(serverReplying({ status: 401, body: "" })),
        yield* detailFor(serverReplying({ status: 502, contentType: "text/plain", body: "" })),
        yield* detailFor(serverReplying({ status: 200, contentType: "text/html", body: SPA_BODY })),
        yield* Fiber.join(timedOut),
      ];
      assert.deepStrictEqual(details, [
        "Could not reach the OpenCode server.",
        "The OpenCode server rejected the server password.",
        "The OpenCode server returned HTTP 502.",
        "The server is not an OpenCode 2 server.",
        "Timed out waiting for the OpenCode server.",
      ]);
      for (const detail of details) {
        assert.notInclude(detail, "url-secret");
        assert.notInclude(detail, "query-secret");
        assert.notInclude(detail, "127.0.0.1");
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("OpenCode2Server managed service", () => {
  it.effect("shares a cold managed-service acquisition between concurrent callers", () =>
    Effect.gen(function* () {
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const firstUseEntered = yield* Deferred.make<void>();
      const releaseFirstUse = yield* Deferred.make<void>();
      const secondUseEntered = yield* Deferred.make<void>();
      const reconnectStartEntered = yield* Deferred.make<void>();
      const releaseReconnectStart = yield* Deferred.make<void>();
      const staleVerifications = yield* Deferred.make<void>();
      const commands: Array<ReadonlyArray<string>> = [];
      let starts = 0;
      let rejectVerifications = false;
      let failedVerifications = 0;
      const runtime = {
        runOpenCodeCommand: (input: { readonly args: ReadonlyArray<string> }) =>
          Effect.gen(function* () {
            commands.push(input.args);
            if (input.args[1] === "start") {
              starts += 1;
              if (starts === 1) {
                yield* Deferred.succeed(startEntered, undefined);
                yield* Deferred.await(releaseStart);
              } else if (starts === 2) {
                yield* Deferred.succeed(reconnectStartEntered, undefined);
                yield* Deferred.await(releaseReconnectStart);
              }
            }
            return {
              stdout:
                input.args[2] === "disabled"
                  ? "false\n"
                  : input.args[1] === "start"
                    ? "http://127.0.0.1:4096\n"
                    : "managed-password\n",
              stderr: "",
              code: 0,
            };
          }),
      } as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            let status = 200;
            if (rejectVerifications && failedVerifications < 2) {
              failedVerifications += 1;
              status = 500;
              if (failedVerifications === 2) yield* Deferred.succeed(staleVerifications, undefined);
              yield* Deferred.await(staleVerifications);
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(INFO_BODY, {
                status,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      );
      const server = yield* OpenCode2Server.make({
        binaryPath: "/configured/opencode",
        serverUrl: "",
        serverPassword: "",
        directory: "/project",
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(
          Layer.mergeAll(OpenCode2Client.layer.pipe(Layer.provide(http)), NodeServices.layer),
        ),
      );
      const bothReady = yield* Deferred.make<void>();
      let readyCount = 0;
      let useCount = 0;
      const borrow = Effect.sync(() => {
        readyCount += 1;
        if (readyCount === 2) return Deferred.succeed(bothReady, undefined);
        return Effect.void;
      }).pipe(
        Effect.flatten,
        Effect.andThen(
          server.withConnection((connection) =>
            Effect.suspend(() => {
              useCount += 1;
              return useCount === 1
                ? Deferred.succeed(firstUseEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstUse)),
                    Effect.as(connection),
                  )
                : Deferred.succeed(secondUseEntered, undefined).pipe(Effect.as(connection));
            }),
          ),
        ),
      );
      const first = yield* borrow.pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* borrow.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(bothReady);
      yield* Deferred.await(startEntered);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStart, undefined);
      yield* Deferred.await(firstUseEntered);
      yield* Deferred.await(secondUseEntered);
      yield* Deferred.succeed(releaseFirstUse, undefined);
      const coldConnections = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      assert.strictEqual(coldConnections[0], coldConnections[1]);
      assert.deepStrictEqual(commands, [
        ["service", "get", "disabled"],
        ["service", "start"],
        ["service", "get", "password"],
      ]);

      rejectVerifications = true;
      readyCount = 0;
      const bothReconnectReady = yield* Deferred.make<void>();
      const reconnect = Effect.sync(() => {
        readyCount += 1;
        if (readyCount === 2) return Deferred.succeed(bothReconnectReady, undefined);
        return Effect.void;
      }).pipe(
        Effect.flatten,
        Effect.andThen(server.withConnection((connection) => Effect.succeed(connection))),
      );
      const reconnectOne = yield* reconnect.pipe(Effect.forkChild({ startImmediately: true }));
      const reconnectTwo = yield* reconnect.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(bothReconnectReady);
      yield* Deferred.await(staleVerifications);
      yield* Deferred.await(reconnectStartEntered);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseReconnectStart, undefined);
      yield* Effect.all([Fiber.join(reconnectOne), Fiber.join(reconnectTwo)]);
      assert.deepStrictEqual(commands, [
        ["service", "get", "disabled"],
        ["service", "start"],
        ["service", "get", "password"],
        ["service", "get", "disabled"],
        ["service", "start"],
        ["service", "get", "password"],
      ]);
    }),
  );

  it.effect("releases the acquisition permit after a failed start so a waiter can retry", () =>
    Effect.gen(function* () {
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const commands: Array<ReadonlyArray<string>> = [];
      let starts = 0;
      const runtime = {
        runOpenCodeCommand: (input: { readonly args: ReadonlyArray<string> }) =>
          Effect.gen(function* () {
            commands.push(input.args);
            if (input.args[1] === "start") {
              starts += 1;
              if (starts === 1) {
                yield* Deferred.succeed(startEntered, undefined);
                yield* Deferred.await(releaseStart);
                return { stdout: "", stderr: "failed", code: 1 };
              }
            }
            return {
              stdout:
                input.args[2] === "disabled"
                  ? "false\n"
                  : input.args[1] === "start"
                    ? "http://127.0.0.1:4096\n"
                    : "managed-password\n",
              stderr: "",
              code: 0,
            };
          }),
      } as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
      const http = serverReplying({
        status: 200,
        contentType: "application/json",
        body: INFO_BODY,
      });
      const server = yield* OpenCode2Server.make({
        binaryPath: "/configured/opencode",
        serverUrl: "",
        serverPassword: "",
        directory: "/project",
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(
          Layer.mergeAll(OpenCode2Client.layer.pipe(Layer.provide(http)), NodeServices.layer),
        ),
      );
      const bothReady = yield* Deferred.make<void>();
      let readyCount = 0;
      const borrow = Effect.sync(() => {
        readyCount += 1;
        if (readyCount === 2) return Deferred.succeed(bothReady, undefined);
        return Effect.void;
      }).pipe(
        Effect.flatten,
        Effect.andThen(
          Effect.exit(server.withConnection((connection) => Effect.succeed(connection))),
        ),
      );
      const first = yield* borrow.pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* borrow.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(bothReady);
      yield* Deferred.await(startEntered);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseStart, undefined);
      const outcomes = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      assert.isTrue(outcomes.some(Exit.isFailure));
      assert.isTrue(outcomes.some(Exit.isSuccess));
      assert.deepStrictEqual(commands, [
        ["service", "get", "disabled"],
        ["service", "start"],
        ["service", "get", "disabled"],
        ["service", "start"],
        ["service", "get", "password"],
      ]);
    }),
  );

  it.effect("uses OpenCode's channel-aware managed service and persisted password", () => {
    const managedPassword = "managed password ";
    const commands: Array<{
      readonly args: ReadonlyArray<string>;
      readonly binaryPath: string;
      readonly cwd?: string;
      readonly environment?: NodeJS.ProcessEnv;
    }> = [];
    const runtime = {
      runOpenCodeCommand: (input: (typeof commands)[number]) =>
        Effect.sync(() => {
          commands.push(input);
          return {
            stdout:
              input.args[2] === "disabled"
                ? "false\n"
                : input.args[1] === "start"
                  ? "http://127.0.0.1:4096\n"
                  : `${managedPassword}\n`,
            stderr: "",
            code: 0,
          };
        }),
    } as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
    const authorizations: Array<string | null> = [];
    let requestCount = 0;
    const statuses = [200, 500, 200, 200];
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          authorizations.push(Option.getOrNull(HttpHeaders.get("authorization")(request.headers)));
          return HttpClientResponse.fromWeb(
            request,
            new Response(INFO_BODY, {
              status: statuses[requestCount++] ?? 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    return Effect.gen(function* () {
      const server = yield* OpenCode2Server.make({
        binaryPath: "/configured/opencode",
        serverUrl: "",
        serverPassword: "",
        directory: "/project",
        environment: { XDG_STATE_HOME: "/isolated/state" },
      });
      const connection = yield* server.withConnection((value) => Effect.succeed(value));
      const second = yield* server.withConnection((value) => Effect.succeed(value));
      const third = yield* server.withConnection((value) => Effect.succeed(value));
      assert.strictEqual(connection.version, "2.0.18");
      assert.isFalse(connection.external);
      assert.notStrictEqual(second.client, connection.client);
      assert.strictEqual(third.client, second.client);
      assert.deepStrictEqual(authorizations, [
        `Basic ${Buffer.from(`opencode:${managedPassword}`, "utf8").toString("base64")}`,
        `Basic ${Buffer.from(`opencode:${managedPassword}`, "utf8").toString("base64")}`,
        `Basic ${Buffer.from(`opencode:${managedPassword}`, "utf8").toString("base64")}`,
        `Basic ${Buffer.from(`opencode:${managedPassword}`, "utf8").toString("base64")}`,
      ]);
      assert.deepStrictEqual(
        commands.map((command) => command.args),
        [
          ["service", "get", "disabled"],
          ["service", "start"],
          ["service", "get", "password"],
          ["service", "get", "disabled"],
          ["service", "start"],
          ["service", "get", "password"],
        ],
      );
      assert.isTrue(commands.every((command) => command.binaryPath === "/configured/opencode"));
      assert.isTrue(commands.every((command) => command.cwd === "/project"));
      assert.isTrue(
        commands.every((command) => command.environment?.XDG_STATE_HOME === "/isolated/state"),
      );
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      Effect.provide(
        Layer.mergeAll(OpenCode2Client.layer.pipe(Layer.provide(http)), NodeServices.layer),
      ),
    );
  });

  it.effect("explains when the OpenCode managed service is disabled without starting it", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    const runtime = {
      runOpenCodeCommand: (input: { readonly args: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          commands.push(input.args);
          return { stdout: "true\n", stderr: "", code: 0 };
        }),
    } as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
    return Effect.gen(function* () {
      const server = yield* OpenCode2Server.make({
        binaryPath: "/configured/opencode",
        serverUrl: "",
        serverPassword: "",
        directory: "/project",
        environment: {},
      });
      const error = yield* server.withConnection(() => Effect.void).pipe(Effect.flip);
      assert.include(error.detail, "background service is disabled");
      assert.deepStrictEqual(commands, [["service", "get", "disabled"]]);
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      Effect.provide(
        Layer.mergeAll(
          OpenCode2Client.layer.pipe(
            Layer.provide(
              serverReplying({ status: 200, contentType: "application/json", body: INFO_BODY }),
            ),
          ),
          NodeServices.layer,
        ),
      ),
    );
  });
});
