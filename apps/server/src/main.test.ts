import * as Http from "node:http";
import { NodeServices } from "@effect/platform-node";
import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { beforeEach } from "vitest";

import { CliConfig, makeCliCommand, type CliConfigShape } from "./main";
import { NetService, ServerConfig, type ServerConfigShape } from "./config";
import { Open, type OpenShape } from "./open";
import { Server, type ServerShape, type ServerOptions } from "./wsServer";

const start = vi.fn(() => undefined);
const stop = vi.fn(() => undefined);
let resolvedConfig: ServerConfigShape | null = null;
const createServer = vi.fn((_: ServerOptions | undefined) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      resolvedConfig = yield* ServerConfig;
      start();
      return {} as unknown as Http.Server;
    }),
    () => Effect.sync(() => stop()),
  ),
);
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));

const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/t3-test-workspace",
    fixPath: Effect.void,
    resolveStaticDir: Effect.undefined,
  } satisfies CliConfigShape),
  Layer.succeed(NetService, {
    findAvailablePort,
  }),
  Layer.succeed(Server, {
    createServer,
    stopSignal: Effect.void,
  } satisfies ServerShape),
  Layer.succeed(Open, {
    openBrowser: (_target: string) => Effect.void,
    openInEditor: () => Effect.void,
  } satisfies OpenShape),
  NodeServices.layer,
);

const runCli = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = { T3CODE_NO_BROWSER: "true" },
) =>
  Command.runWith(makeCliCommand(), { version: "0.0.0-test" })(args).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConfig = null;
  start.mockImplementation(() => undefined);
  stop.mockImplementation(() => undefined);
  createServer.mockImplementation((_: ServerOptions | undefined) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        resolvedConfig = yield* ServerConfig;
        start();
        return {} as unknown as Http.Server;
      }),
      () => Effect.sync(() => stop()),
    ),
  );
  findAvailablePort.mockImplementation((preferred: number) => Effect.succeed(preferred));
});

it.layer(testLayer)("server cli", (it) => {
  it.effect("parses --port and --token and wires scoped start/stop", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "4010", "--token", "secret"]);

      assert.equal(createServer.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 4010);
      assert.equal(resolvedConfig?.authToken, "secret");
      assert.equal(start.mock.calls.length, 1);
      assert.equal(stop.mock.calls.length, 1);
    }),
  );

  it.effect("uses env fallbacks when flags are not provided", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_NO_BROWSER: "true",
        T3CODE_PORT: "4999",
        T3CODE_AUTH_TOKEN: "env-token",
      });

      assert.equal(createServer.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 4999);
      assert.equal(resolvedConfig?.authToken, "env-token");
      assert.equal(findAvailablePort.mock.calls.length, 0);
    }),
  );

  it.effect("uses dynamic port discovery in web mode when port is omitted", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(5444));
      yield* runCli([]);

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(createServer.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 5444);
      assert.equal(resolvedConfig?.mode, "web");
    }),
  );

  it.effect("uses fixed localhost defaults in desktop mode", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_MODE: "desktop",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(findAvailablePort.mock.calls.length, 0);
      assert.equal(createServer.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 3773);
      assert.equal(resolvedConfig?.mode, "desktop");
    }),
  );

  it.effect("does not start server for out-of-range --port values", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "70000"]);

      // effect/unstable/cli renders help/errors for parse failures and returns success.
      assert.equal(createServer.mock.calls.length, 0);
      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );
});
