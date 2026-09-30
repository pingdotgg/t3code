import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
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
  readonly contentType: string;
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
            headers: { "content-type": reply.contentType },
          }),
        ),
      ),
    ),
  );

const verify = (
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  url = "http://127.0.0.1:4096",
  password: Redacted.Redacted = Redacted.make("test-only-secret"),
) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const client = yield* opencode.connect({ baseUrl: url, password });
    return yield* OpenCode2Server.verifyServer(client, url);
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
        "http://127.0.0.1:4096",
        Redacted.make("test-only-secret"),
      ).pipe(Effect.flip);
      assert.include(error.detail, "rejected the server password");
    }),
  );

  it.effect("never leaks the password into auth-failure errors", () =>
    Effect.gen(function* () {
      const secret = "auth-failure-secret-pw";
      const failure = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(UNAUTHORIZED_BODY, {
                status: 401,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      );
      const error = yield* verify(failure, "http://127.0.0.1:4096", Redacted.make(secret)).pipe(
        Effect.flip,
      );
      NodeAssert.ok(!error.detail.includes(secret), "error detail must not contain the password");
      NodeAssert.ok(
        !String(error.cause ?? "").includes(secret),
        "error cause must not contain the password",
      );
      NodeAssert.ok(
        !String(error).includes(secret),
        "serialized error must not contain the password",
      );
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

describe("OpenCode2Server passwords", () => {
  it.effect("generates a distinct 256-bit password per server", () =>
    Effect.gen(function* () {
      const first = yield* OpenCode2Server.generatePassword;
      const second = yield* OpenCode2Server.generatePassword;
      assert.match(Redacted.value(first), /^[A-Za-z0-9_-]{43}$/);
      assert.notStrictEqual(Redacted.value(first), Redacted.value(second));
      assert.notInclude(String(first), Redacted.value(first));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("hands the spawned server only the T3 password", () => {
    const password = Redacted.make("t3-generated");
    const environment = OpenCode2Server.serverEnvironment(
      { PATH: "/bin", OPENCODE_SERVER_PASSWORD: "ambient", OPENCODE_PASSWORD: "ambient" },
      password,
    );
    assert.deepStrictEqual(environment, { PATH: "/bin", OPENCODE_PASSWORD: "t3-generated" });
  });

  it.effect("never exposes the generated password through Redacted rendering", () =>
    Effect.gen(function* () {
      const password = yield* OpenCode2Server.generatePassword;
      const secret = Redacted.value(password);
      const rendered = String(password);
      NodeAssert.ok(!rendered.includes(secret), "Redacted toString must not contain the secret");
      // `toJSON` delegates to the same redacted rendering (`<redacted…>`).
      NodeAssert.equal(rendered, "<redacted:OPENCODE_PASSWORD>");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// Serves /api/info only with the password from OPENCODE_PASSWORD, like 2.x.
// The 1.x `/global/health` shape is answered freely: main's
// `startOpenCodeServerProcess` always runs that check first (the `verify`
// hook replaces it on the V2 branch), and the owner passes no 1.x password
// here, so no `Authorization` header arrives on that path. A real 2.x server
// is verified through `/api/info` with the T3 password, which the live test
// covers. The fake prints the 2.x banner (plus the generated-password line
// 2.x prints when no password is set, which T3 must never need).
const FAKE_SERVER = `import { createServer } from "node:http";
const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
const server = createServer((request, response) => {
  if (request.url !== undefined && request.url.split("?")[0] === "/global/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ healthy: true, version: "2.0.18" }));
    return;
  }
  if (request.headers.authorization !== expected) {
    response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Basic" });
    response.end(${JSON.stringify(UNAUTHORIZED_BODY)});
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ version: "2.0.18", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }));
  return;
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("server listening on http://127.0.0.1:" + server.address().port + "\\n");
  process.stdout.write("server password not-the-t3-password\\n");
});
`;

describe("OpenCode2Server spawned server", () => {
  // Main's `startOpenCodeServerProcess` always runs the 1.x `global.health`
  // check first (the `verify` hook replaces it on the V2 branch), so the fake
  // answers health freely and guards `/api/info` with the T3 password from
  // `OPENCODE_PASSWORD` — the 2.x half the live test covers against a real
  // server. The ambient 1.x password is stripped here to prove the owner gets
  // only the T3 password.
  it.live(
    "is ready once /api/info accepts the generated password",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode2-fake-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(directory, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(directory, "opencode.mjs");
        yield* fs.writeFileString(scriptPath, FAKE_SERVER);
        const executablePath = yield* HostProcessExecutablePath;
        yield* fs.writeFileString(
          binaryPath,
          isWindows
            ? `@echo off\r\n"${executablePath}" "${scriptPath}" %*\r\n`
            : `#!/bin/sh\nexec "${executablePath}" "${scriptPath}" "$@"\n`,
        );
        if (!isWindows) yield* fs.chmod(binaryPath, 0o755);

        const hostEnvironment = yield* HostProcessEnvironment;
        const { OPENCODE_SERVER_PASSWORD: _ambient, ...restEnvironment } = hostEnvironment;
        const server = yield* OpenCode2Server.make({
          binaryPath,
          serverUrl: "",
          serverPassword: Redacted.make(""),
          directory,
          environment: restEnvironment,
        });
        const first = yield* server.withConnection((connection) => Effect.succeed(connection));
        const second = yield* server.withConnection((connection) => Effect.succeed(connection));
        assert.strictEqual(first.version, "2.0.18");
        assert.strictEqual(first.external, false);
        assert.strictEqual(second.client, first.client);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(OpenCode2Client.layer, OpenCodeRuntimeLive).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
          ),
        ),
      ),
    15_000,
  );
});

describe("OpenCode2Server orphan/lifecycle", () => {
  const unusedRuntimeMethod = () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "unused",
        detail: "unused test method",
      }),
    );

  // Fake runtime with a controllable unverified spawn and close tracking.
  // The owner under test provides the spawn scope; the fake records scope
  // closes so double-stop and verify-failure leaks are observable.
  const makeUnverifiedRuntime = () => {
    const startCount = { current: 0 };
    const closeCount = { current: 0 };
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: unusedRuntimeMethod as never,
      startUnverifiedOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          startCount.current += 1;
          const url = `http://127.0.0.1:${4000 + startCount.current}`;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closeCount.current += 1;
            }),
          );
          return {
            url,
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };
    return { runtime, startCount, closeCount };
  };

  it.effect("external URL spawns nothing: shutdown stops nothing", () =>
    Effect.gen(function* () {
      const testRuntime = makeUnverifiedRuntime();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* OpenCode2Server.make({
            binaryPath: "opencode",
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: Redacted.make("external-secret"),
            directory: "/work/dir",
            environment: {},
          });
          const connection = yield* server.withConnection((value) => Effect.succeed(value));
          assert.strictEqual(connection.external, true);
          assert.strictEqual(connection.version, "2.0.18");
          // No spawn happened for an external URL: nothing to stop, reap, or
          // ledger — the scoped teardown closes no server scope.
          assert.strictEqual(testRuntime.startCount.current, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              OpenCode2Client.layer.pipe(
                Layer.provide(
                  serverReplying({ status: 200, contentType: "application/json", body: INFO_BODY }),
                ),
              ),
            ),
          ),
          Effect.provideService(OpenCodeRuntime, testRuntime.runtime),
        ),
      );
      assert.strictEqual(testRuntime.closeCount.current, 0);
    }),
  );

  it.effect("failed verify stops the spawned process (no leak)", () =>
    Effect.gen(function* () {
      const testRuntime = makeUnverifiedRuntime();
      // The spawned server answers /api/info with HTML: verify fails, and
      // the owner must close the spawn scope it just opened.
      const htmlLayer = serverReplying({
        status: 200,
        contentType: "text/html",
        body: SPA_BODY,
      });
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* OpenCode2Server.make({
            binaryPath: "opencode",
            serverUrl: "",
            serverPassword: Redacted.make(""),
            directory: "/work/dir",
            environment: {},
          });
          return yield* server.withConnection((value) => Effect.succeed(value));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(NodeCrypto.layer, OpenCode2Client.layer.pipe(Layer.provide(htmlLayer))),
          ),
          Effect.provideService(OpenCodeRuntime, testRuntime.runtime),
        ),
      ).pipe(Effect.exit);
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(testRuntime.startCount.current, 1);
      assert.strictEqual(
        testRuntime.closeCount.current,
        1,
        "a verify failure must close the spawn scope it opened",
      );
    }),
  );

  it.effect("double scope close stops the spawned server once", () =>
    Effect.gen(function* () {
      const testRuntime = makeUnverifiedRuntime();
      const jsonLayer = serverReplying({
        status: 200,
        contentType: "application/json",
        body: INFO_BODY,
      });
      const scope = yield* Scope.make();
      const build = OpenCode2Server.make({
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: Redacted.make(""),
        directory: "/work/dir",
        environment: {},
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeCrypto.layer, OpenCode2Client.layer.pipe(Layer.provide(jsonLayer))),
        ),
        Effect.provideService(OpenCodeRuntime, testRuntime.runtime),
        Effect.provideService(Scope.Scope, scope),
      );
      const server = yield* build;
      const first = yield* server.withConnection((value) => Effect.succeed(value.url));
      const second = yield* server.withConnection((value) => Effect.succeed(value.url));
      assert.strictEqual(first, second);
      assert.strictEqual(testRuntime.startCount.current, 1);
      // Borrowed twice and released; closing the owner scope stops the
      // server once, and a second close is a no-op (Scope.close is
      // idempotent — no second spawn or second stop may happen).
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(testRuntime.closeCount.current, 1);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(testRuntime.startCount.current, 1);
      assert.strictEqual(testRuntime.closeCount.current, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("subagent children do not pin the server: stopAll needs no server stop", () =>
    Effect.gen(function* () {
      // Session-alive guarantee lives in OpenCode2SessionStore (stop aborts
      // parent + descendants; stopAll clears the store). The server layer
      // only promises borrow symmetry: stopping every session releases every
      // borrow, and the owner then idles the server out — no child session
      // keeps a server alive on its own.
      const testRuntime = makeUnverifiedRuntime();
      const jsonLayer = serverReplying({
        status: 200,
        contentType: "application/json",
        body: INFO_BODY,
      });
      const scope = yield* Scope.make();
      const server = yield* OpenCode2Server.make({
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: Redacted.make(""),
        directory: "/work/dir",
        environment: {},
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeCrypto.layer, OpenCode2Client.layer.pipe(Layer.provide(jsonLayer))),
        ),
        Effect.provideService(OpenCodeRuntime, testRuntime.runtime),
        Effect.provideService(Scope.Scope, scope),
      );
      // Two borrows (parent + background child) share one spawn; both
      // releases run, and only the scope close stops the server.
      const parent = yield* server.withConnection((value) => Effect.succeed(value.url));
      const child = yield* server.withConnection((value) => Effect.succeed(value.url));
      assert.strictEqual(parent, child);
      assert.strictEqual(testRuntime.startCount.current, 1);
      assert.strictEqual(testRuntime.closeCount.current, 0);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(testRuntime.closeCount.current, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("owner verify path uses unverified spawn, never the 1.x health gate", () =>
    Effect.gen(function* () {
      // The 1.x gate rejects 2.x servers (SPA HTML on /global/health), so
      // the verify path must call startUnverified when present and must
      // never call the legacy start. A runtime without the unverified entry
      // point falls back to legacy start (v1 behavior, unchanged).
      const legacyCalls = { current: 0 };
      const unverifiedCalls = { current: 0 };
      const base = makeUnverifiedRuntime();
      const runtimeWithBoth: OpenCodeRuntimeShape = {
        ...base.runtime,
        startOpenCodeServerProcess: (() =>
          Effect.sync(() => {
            legacyCalls.current += 1;
            throw new Error("legacy start must not run on the verify path");
          })) as never,
        startUnverifiedOpenCodeServerProcess: () =>
          Effect.gen(function* () {
            unverifiedCalls.current += 1;
            return yield* base.runtime.startUnverifiedOpenCodeServerProcess!({
              binaryPath: "opencode",
              directory: "/work/dir",
            });
          }),
      };
      const jsonLayer = serverReplying({
        status: 200,
        contentType: "application/json",
        body: INFO_BODY,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* OpenCodeServerOwner.make({
            binaryPath: "opencode",
            directory: "/work/dir",
            verify: () => Effect.succeed("2.0.18"),
          });
          const url = yield* owner.withServer((value) => Effect.succeed(value.url));
          assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(NodeCrypto.layer, OpenCode2Client.layer.pipe(Layer.provide(jsonLayer))),
          ),
          Effect.provideService(OpenCodeRuntime, runtimeWithBoth),
        ),
      );
      assert.strictEqual(unverifiedCalls.current, 1);
      assert.strictEqual(legacyCalls.current, 0);
    }),
  );
});
