import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CursorConfigureOptions } from "@cursor/sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";

const sdkDefaults = vi.hoisted(() => ({ useHttp1ForAgent: undefined as boolean | undefined }));

// Holds the SDK's process-wide default the way it does: only keys present change, null clears.
vi.mock("./sdk.ts", () => ({
  Agent: {},
  createAgentPlatform: {},
  SqliteLocalAgentStore: {},
  Cursor: {
    configure: ({ local }: CursorConfigureOptions) => {
      if (local !== undefined && "useHttp1ForAgent" in local) {
        sdkDefaults.useHttp1ForAgent = local.useHttp1ForAgent ?? undefined;
      }
    },
  },
}));

const withHost = (environment: NodeJS.ProcessEnv, home: string) =>
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcess.Environment, environment),
      Layer.succeed(HostProcess.HomeDirectory, home),
    ),
  );

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the guard directly, with Vitest's own listener detached so the guard does not defer to it.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(Effect.scoped, withHost({}, "/nonexistent-home"));

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );
});

const http1 = JSON.stringify({ network: { useHttp1ForAgent: true } });

describe("CursorSdk agent transport", () => {
  it.effect.each([
    {
      name: "CURSOR_CONFIG_DIR before XDG_CONFIG_HOME",
      env: { CURSOR_CONFIG_DIR: "config", XDG_CONFIG_HOME: "xdg" },
      file: "config/cli-config.json",
      text: http1,
      expected: true,
    },
    {
      name: "XDG_CONFIG_HOME",
      env: { XDG_CONFIG_HOME: "xdg" },
      file: "xdg/cursor/cli-config.json",
      text: http1,
      expected: true,
    },
    {
      name: "the home directory",
      env: {},
      file: "home/.cursor/cli-config.json",
      text: http1,
      expected: true,
    },
    {
      name: "an HTTP/2 setting",
      env: {},
      file: "home/.cursor/cli-config.json",
      text: JSON.stringify({ network: { useHttp1ForAgent: false } }),
      expected: undefined,
    },
    {
      name: "a damaged file",
      env: {},
      file: "home/.cursor/cli-config.json",
      text: "{",
      expected: undefined,
    },
    { name: "no file", env: {}, file: undefined, text: "", expected: undefined },
  ])("follows the Cursor CLI's HTTP/1.1 setting from $name", ({ env, file, text, expected }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-cli-config-" });
      if (file !== undefined) {
        yield* fileSystem.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, file), text);
      }
      const environment = Object.fromEntries(
        Object.entries(env).map(([key, directory]) => [key, path.join(root, directory)]),
      );
      yield* Effect.gen(function* () {
        yield* Layer.build(CursorSdk.layer);
        assert.strictEqual(sdkDefaults.useHttp1ForAgent, expected);
      }).pipe(Effect.scoped, withHost(environment, path.join(root, "home")));
      assert.isUndefined(sdkDefaults.useHttp1ForAgent);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
