import { NodeServices } from "@effect/platform-node";
import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { beforeEach } from "vitest";

import { CliConfig, makeCliCommand, type CliConfigShape } from "./main";
import { Open, type OpenShape } from "./open";
import { Server, type ServerShape, type ServerOptions } from "./wsServer";

const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const createServer = vi.fn((_: ServerOptions) => ({
  start,
  stop,
  httpServer: undefined as never,
}));
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));

const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/t3-test-workspace",
    fixPath: Effect.void,
    findAvailablePort,
    resolveStaticDir: Effect.undefined,
  } satisfies CliConfigShape),
  Layer.succeed(Server, {
    createServer,
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
  start.mockImplementation(async () => undefined);
  stop.mockImplementation(async () => undefined);
  createServer.mockImplementation((_: ServerOptions) => ({
    start,
    stop,
    httpServer: undefined as never,
  }));
  findAvailablePort.mockImplementation((preferred: number) => Effect.succeed(preferred));
});

it.layer(testLayer)("server cli", (it) => {
  it.effect("parses --port and --token and wires scoped start/stop", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "4010", "--token", "secret"]);

      assert.equal(createServer.mock.calls.length, 1);
      const options = createServer.mock.calls[0]?.[0];
      assert.equal(options?.port, 4010);
      assert.equal(options?.authToken, "secret");
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
      const options = createServer.mock.calls[0]?.[0];
      assert.equal(options?.port, 4999);
      assert.equal(options?.authToken, "env-token");
      assert.equal(findAvailablePort.mock.calls.length, 0);
    }),
  );

  it.effect("uses dynamic port discovery in web mode when port is omitted", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(5444));
      yield* runCli([]);

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(createServer.mock.calls.length, 1);
      const options = createServer.mock.calls[0]?.[0];
      assert.equal(options?.port, 5444);
      assert.equal(options?.host, undefined);
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
      const options = createServer.mock.calls[0]?.[0];
      assert.equal(options?.port, 3773);
      assert.equal(options?.host, "127.0.0.1");
    }),
  );

  it.effect("fails for out-of-range --port values", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(runCli(["--port", "70000"]));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.message,
          "Invalid --port: 70000. Expected an integer between 1 and 65535.",
        );
      }
      assert.equal(createServer.mock.calls.length, 0);
    }),
  );
});
