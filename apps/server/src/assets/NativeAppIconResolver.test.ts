import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

function processHandle(output = "") {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(output)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-native-app-icon-test-",
}).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const makeFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-app-bundle-" });
  const appPath = path.join(root, ".hidden", "Review App.app");
  // No Resources directory or icon file: native icons can come from asset catalogs.
  yield* fs.makeDirectory(path.join(appPath, "Contents"), { recursive: true });
  const canonicalAppPath = yield* fs.realPath(appPath);
  const commands: Array<ChildProcess.StandardCommand> = [];
  const state = {
    nativePath: appPath,
    nativeFailure: false,
    spotlightOutput: "",
    iconFailure: false,
    version: "1",
  };
  const failure = PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: "Native helper failed",
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipe");
      commands.push(command);
      switch (command.command) {
        case "/usr/bin/osascript":
          if (command.args.length === 5) {
            if (state.nativeFailure) return yield* failure;
            return processHandle(state.nativePath);
          }
          expect(command.args[4]).toBe(canonicalAppPath);
          expect(command.args[6]).toBe("64");
          yield* fs.writeFileString(command.args[5]!, "native PNG");
          if (state.iconFailure) return yield* failure;
          return processHandle();
        case "/usr/bin/mdfind":
          return processHandle(state.spotlightOutput);
        case "/usr/bin/mdls":
          return processHandle("2026-09-07 00:00:00 +0000");
        case "/usr/bin/plutil":
          return processHandle(state.version);
        default:
          return yield* Effect.die(`Unexpected command: ${command.command}`);
      }
    }),
  );
  const makeResolver = NativeAppIconResolver.make.pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const resolver = yield* makeResolver;
  return {
    resolver,
    makeResolver,
    commands,
    state,
    appPath,
    cacheDirectory: path.join(config.providerStatusCacheDir, "native-app-icons"),
  };
});

describe("resolveNativeAppIcon", () => {
  it.effect("escapes Spotlight wildcards and caches misses", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipe");
        commands.push(command);
        return processHandle();
      }),
    );
    const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-native-app-icon-test-",
    });
    const dependencies = Layer.mergeAll(
      configLayer,
      Layer.succeed(HostProcessPlatform, "darwin"),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = NativeAppIconResolver.layer.pipe(Layer.provide(dependencies));
    const app = { _tag: "display-name", displayName: "Review * App" } as const;

    return Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.NativeAppIconResolver;
      expect(yield* resolver.resolve(app)).toBeNull();
      expect(yield* resolver.resolve(app)).toBeNull();

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ command: "/usr/bin/mdfind" });
      expect(commands[0]?.args[0]).toContain("Review \\* App");

      for (let index = 0; index < 256; index += 1) {
        expect(
          yield* resolver.resolve({
            _tag: "display-name",
            displayName: `Missing Review App ${index}`,
          }),
        ).toBeNull();
      }
      expect(commands).toHaveLength(257);
      expect(yield* resolver.resolve(app)).toBeNull();
      expect(commands).toHaveLength(258);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("resolves unindexed bundles natively without needing an icon file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const app = { _tag: "app-id", appId: "com.example.hidden.dev" } as const;
      const icon = yield* fixture.resolver.resolve(app);
      expect(icon).not.toBeNull();
      expect(yield* fs.readFileString(icon!)).toBe("native PNG");
      expect(fixture.commands.some((command) => command.command === "/usr/bin/mdfind")).toBe(false);
      expect(yield* fixture.resolver.resolve(app)).toBe(icon);
      expect(fixture.commands).toHaveLength(3);

      // A new resolver reuses the PNG on disk; deleting it regenerates the image.
      const freshResolver = yield* fixture.makeResolver;
      expect(yield* freshResolver.resolve(app)).toBe(icon);
      expect(fixture.commands).toHaveLength(5);
      yield* fs.remove(icon!);
      expect(yield* freshResolver.resolve(app)).toBe(icon);
      expect(yield* fs.readFileString(icon!)).toBe("native PNG");
      expect(fixture.commands).toHaveLength(8);

      fixture.state.version = "2";
      yield* TestClock.adjust("1 hour");
      expect(yield* freshResolver.resolve(app)).not.toBe(icon);
    }).pipe(Effect.provide(testLayer)),
  );

  for (const nativeFailure of [false, true]) {
    it.effect(
      `falls back to Spotlight when native lookup ${nativeFailure ? "fails" : "misses"}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          fixture.state.nativePath = "";
          fixture.state.nativeFailure = nativeFailure;
          fixture.state.spotlightOutput = `${fixture.appPath}\n`;
          expect(
            yield* fixture.resolver.resolve({ _tag: "app-id", appId: "com.example.review" }),
          ).not.toBeNull();
          expect(fixture.commands.slice(0, 3).map((command) => command.command)).toEqual([
            "/usr/bin/osascript",
            "/usr/bin/mdfind",
            "/usr/bin/mdls",
          ]);
        }).pipe(Effect.provide(testLayer)),
    );
  }

  it.effect("resolves display names through Spotlight and renders the native icon", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.state.spotlightOutput = `${fixture.appPath}\n`;
      expect(
        yield* fixture.resolver.resolve({ _tag: "display-name", displayName: "Review App" }),
      ).not.toBeNull();
      expect(fixture.commands[0]?.command).toBe("/usr/bin/mdfind");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retries missing applications after a short cache interval", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const app = { _tag: "app-id", appId: "com.example.newly-installed" } as const;
      fixture.state.nativePath = "";
      expect(yield* fixture.resolver.resolve(app)).toBeNull();
      fixture.state.nativePath = fixture.appPath;
      expect(yield* fixture.resolver.resolve(app)).toBeNull();
      expect(fixture.commands).toHaveLength(2);
      yield* TestClock.adjust("30 seconds");
      expect(yield* fixture.resolver.resolve(app)).not.toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("cleans up failed renders and retries without caching the failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const app = { _tag: "app-id", appId: "com.example.review" } as const;
      fixture.state.iconFailure = true;
      expect(yield* fixture.resolver.resolve(app)).toBeNull();
      expect(yield* fs.readDirectory(fixture.cacheDirectory)).toEqual([]);
      fixture.state.iconFailure = false;
      expect(yield* fixture.resolver.resolve(app)).not.toBeNull();
      expect(yield* fs.readDirectory(fixture.cacheDirectory)).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  for (const platform of ["linux", "win32"] as const) {
    it.effect(`does not invoke macOS commands on ${platform}`, () =>
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make(() => Effect.die("Unexpected macOS command"));
        const resolver = yield* NativeAppIconResolver.make.pipe(
          Effect.provideService(HostProcessPlatform, platform),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(yield* resolver.resolve({ _tag: "app-id", appId: "com.example.review" })).toBeNull();
      }).pipe(Effect.provide(testLayer)),
    );
  }
});
