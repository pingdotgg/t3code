import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeApplicationResolver } from "@t3tools/shared/nativeAppIcon";

import * as ServerConfig from "../config.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

function emptyProcessHandle(output = "") {
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

describe("resolveNativeAppIcon", () => {
  it.effect("backs off failed app lookups and retries after a minute", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcessSpawner",
                  method: "spawn",
                }),
              )
            : Effect.succeed(
                emptyProcessHandle(
                  '{"path":"/Applications/Review.app","displayName":"Review","version":"1"}',
                ),
              );
        }),
      );
      const resolve = yield* makeApplicationResolver().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      const app = { _tag: "app-id", appId: "dev.review.app" } as const;
      expect(yield* resolve(app)).toBeNull();
      expect(yield* resolve(app)).toBeNull();
      expect(attempts).toBe(1);
      yield* TestClock.adjust("61 seconds");
      expect(yield* resolve(app)).toMatchObject({ displayName: "Review" });
      expect(attempts).toBe(2);
    }),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() !== "darwin")(
    "renders visible pixels at the requested dimensions on macOS",
    () =>
      Effect.gen(function* () {
        const resolver = yield* NativeAppIconResolver.make;
        const icon = yield* resolver.resolve({ _tag: "app-id", appId: "com.apple.finder" });
        expect(icon).not.toBeNull();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pixels = yield* spawner.string(
          ChildProcess.make("/usr/bin/osascript", [
            "-l",
            "JavaScript",
            "-e",
            `
          ObjC.import('AppKit');
          function run(argv) {
            var bitmap = $.NSBitmapImageRep.imageRepWithContentsOfFile(argv[0]);
            return JSON.stringify([Number(bitmap.pixelsWide), Number(bitmap.pixelsHigh), bitmap.colorAtXY(32, 32).alphaComponent > 0]);
          }
        `,
            icon!,
          ]),
        );
        expect(pixels.trim()).toBe("[64,64,true]");
      }).pipe(
        Effect.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-native-app-render-test-",
          }).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "resolves names and icons without Spotlight or standalone icon files, and repairs a deleted cache file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let lookups = 0;
        let renders = 0;
        const application = { path: "/Unindexed/Review.app", displayName: "Review", version: "1" };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const input = command as unknown as { command: string; args: ReadonlyArray<string> };
            expect(input.command).toBe("/usr/bin/osascript");
            if (input.args.length === 5) {
              lookups++;
              return emptyProcessHandle(
                '{"path":"/Unindexed/Review.app","displayName":"Review","version":"1"}',
              );
            }
            renders++;
            expect(input.args.at(-2)).toBe(application.path);
            yield* fs.writeFileString(input.args.at(-1)!, "rendered icon");
            return emptyProcessHandle();
          }),
        );
        const app = { _tag: "app-id", appId: "dev.review.app" } as const;
        const program = Effect.gen(function* () {
          const resolveApplication = yield* makeApplicationResolver();
          expect(yield* resolveApplication(app)).toEqual(application);
          expect(yield* resolveApplication(app)).toEqual(application);
          expect(lookups).toBe(1);
          const resolver = yield* NativeAppIconResolver.make;
          const icon = yield* resolver.resolve(app);
          expect(icon).not.toBeNull();
          expect(yield* resolver.resolve(app)).toBe(icon);
          expect(renders).toBe(1);
          yield* fs.remove(icon!);
          expect(yield* resolver.resolve(app)).toBe(icon);
          expect(renders).toBe(2);
        });
        yield* program.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-native-app-icon-test-",
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not run macOS commands on other hosts", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.die("unexpected native lookup"));
      const resolve = yield* makeApplicationResolver().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(yield* resolve({ _tag: "app-id", appId: "dev.review" })).toBeNull();
    }),
  );

  it.effect("passes app names as data and bounds cached misses", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const input = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        commands.push(input);
        return emptyProcessHandle();
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
      expect(commands[0]).toMatchObject({ command: "/usr/bin/osascript" });
      expect(commands[0]!.args.at(-1)).toBe('{"_tag":"display-name","displayName":"Review * App"}');

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
});
