import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "./hostProcess.ts";
import { readImageDimensions } from "./imageDimensions.ts";
import { makeApplicationResolver, makeNativeAppIconResolver } from "./nativeAppIcon.ts";

const decodeRenderRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      path: Schema.String,
      outputPath: Schema.String,
      size: Schema.Number,
    }),
  ),
);
const decodeOptionalRenderRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ outputPath: Schema.optional(Schema.String) })),
);
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const processHandle = (output = "") =>
  ChildProcessSpawner.makeHandle({
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

it.effect(
  "uses the capture's known path, caches the icon, and recovers a deleted PNG on Windows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(directory, "Review ' $() App.exe");
      yield* fs.writeFileString(executable, "executable fixture");
      let renders = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
          const request = decodeRenderRequest(command.options.env!.T3_NATIVE_APP_INPUT!);
          expect(request.path).toBe(executable);
          expect(request.size).toBe(128);
          expect(command.args.join(" ")).not.toContain(executable);
          yield* fs.writeFileString(request.outputPath, "rendered PNG");
          renders++;
          return processHandle();
        }),
      );
      yield* Effect.gen(function* () {
        const resolver = yield* makeNativeAppIconResolver(path.join(directory, "icons"), 128).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
        const app = { _tag: "path", path: executable } as const;
        const icon = yield* resolver.resolve(app);
        expect(icon).not.toBeNull();
        expect(yield* resolver.resolve(app)).toBe(icon);
        expect(renders).toBe(1);
        yield* fs.remove(icon!);
        expect(yield* resolver.resolve(app)).toBe(icon);
        expect(renders).toBe(2);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves Windows executable names and packaged app IDs as lookup data", () =>
  Effect.gen(function* () {
    const references: unknown[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
        references.push(decodeInput(command.options.env!.T3_NATIVE_APP_INPUT!));
        return processHandle(
          '{"path":"C:\\\\Apps\\\\Review.exe","displayName":"Review","version":"1"}',
        );
      }),
    );
    const resolve = yield* makeApplicationResolver().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
    for (const appId of ["review.exe", "Review_123!App"]) {
      const reference = { _tag: "app-id", appId } as const;
      expect(yield* resolve(reference)).toMatchObject({ displayName: "Review" });
      expect(yield* resolve(reference)).toMatchObject({ displayName: "Review" });
      expect(references.at(-1)).toEqual(reference);
    }
    expect(references).toHaveLength(2);
  }),
);

it.effect("retries missing applications and their icons after a minute", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    let lookups = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
        const input = decodeOptionalRenderRequest(command.options.env!.T3_NATIVE_APP_INPUT!);
        if (input.outputPath) {
          yield* fs.writeFileString(input.outputPath, "PNG");
          return processHandle();
        }
        lookups++;
        return processHandle(
          lookups === 1 ? "null" : '{"path":"Review.exe","displayName":"Review","version":"1"}',
        );
      }),
    );
    const resolver = yield* makeNativeAppIconResolver(directory).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
    const resolve = (app: Parameters<typeof resolver.resolve>[0]) =>
      resolver
        .resolve(app)
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const app = { _tag: "app-id", appId: "review.exe" } as const;
    expect(yield* resolve(app)).toBeNull();
    expect(yield* resolve(app)).toBeNull();
    expect(lookups).toBe(1);
    yield* TestClock.adjust("61 seconds");
    expect(yield* resolve(app)).not.toBeNull();
    expect(lookups).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("renders a fresh icon when the application changes on disk", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const executable = path.join(directory, "Review.exe");
    yield* fs.writeFileString(executable, "executable");
    let renders = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
        const request = decodeRenderRequest(command.options.env!.T3_NATIVE_APP_INPUT!);
        renders++;
        yield* fs.writeFileString(request.outputPath, `PNG ${renders}`);
        return processHandle();
      }),
    );
    const resolver = yield* makeNativeAppIconResolver(path.join(directory, "icons")).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
    const resolve = () =>
      resolver
        .resolve({ _tag: "path", path: executable })
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const first = yield* resolve();
    expect(first).not.toBeNull();
    expect(yield* resolve()).toBe(first);
    expect(renders).toBe(1);
    // An update rewrites the executable; the cached icon must not be reused.
    // Numeric utimes values are seconds; milliseconds are rejected on Windows.
    const updatedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T00:00:00Z")) / 1000;
    yield* fs.utimes(executable, updatedAt, updatedAt);
    yield* TestClock.adjust("61 minutes");
    const second = yield* resolve();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(renders).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("backs off failed renders and retries after a minute", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const executable = path.join(directory, "Review.exe");
    yield* fs.writeFileString(executable, "executable");
    let attempts = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        attempts++;
        if (attempts === 1)
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcessSpawner",
              method: "spawn",
            }),
          );
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
        const request = decodeRenderRequest(command.options.env!.T3_NATIVE_APP_INPUT!);
        yield* fs.writeFileString(request.outputPath, "PNG");
        return processHandle();
      }),
    );
    const resolver = yield* makeNativeAppIconResolver(path.join(directory, "icons")).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
    const resolve = (app: Parameters<typeof resolver.resolve>[0]) =>
      resolver
        .resolve(app)
        .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const app = { _tag: "path", path: executable } as const;
    expect(yield* resolve(app)).toBeNull();
    expect(yield* resolve(app)).toBeNull();
    expect(attempts).toBe(1);
    yield* TestClock.adjust("61 seconds");
    expect(yield* resolve(app)).not.toBeNull();
    expect(attempts).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(
  HostProcessPlatform.defaultValue() !== "darwin" && HostProcessPlatform.defaultValue() !== "win32",
)(
  "renders a native app icon without Electron at desktop and tool-activity sizes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const app =
        HostProcessPlatform.defaultValue() === "darwin"
          ? ({ _tag: "path", path: "/System/Library/CoreServices/Finder.app" } as const)
          : ({ _tag: "path", path: `${process.env.SYSTEMROOT}\\System32\\cmd.exe` } as const);
      const byId = yield* makeNativeAppIconResolver(directory);
      const resolved = yield* byId.resolve({
        _tag: "app-id",
        appId: HostProcessPlatform.defaultValue() === "darwin" ? "com.apple.finder" : "cmd.exe",
      });
      expect(resolved).not.toBeNull();
      expect(readImageDimensions(yield* fs.readFile(resolved!))).toEqual({ width: 64, height: 64 });
      for (const size of [64, 128]) {
        const resolver = yield* makeNativeAppIconResolver(directory, size);
        const icon = yield* resolver.resolve(app);
        expect(icon).not.toBeNull();
        expect(readImageDimensions(yield* fs.readFile(icon!))).toEqual({
          width: size,
          height: size,
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);
