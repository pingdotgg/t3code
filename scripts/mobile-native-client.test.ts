import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestConsole from "effect/testing/TestConsole";

import { NativeClientError, prebuildAndroid } from "./mobile-native-client.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "android-prebuild-test-" });
  const android = path.join(mobile, "android");
  const file = (relative: string) => path.join(android, relative);
  for (const relative of [
    ".gradle/history",
    "app/.cxx/object",
    "build/autolinking",
    "app/build/bundle",
  ]) {
    yield* fs.makeDirectory(path.dirname(file(relative)), { recursive: true });
    yield* fs.writeFileString(file(relative), relative);
  }
  yield* fs.writeFileString(file("obsolete-source"), "old");
  const regenerate = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(android);
    yield* fs.writeFileString(file("new-source"), "new");
  });
  return { fs, path, mobile, android, file, regenerate };
});

it.layer(NodeServices.layer)("Android clean prebuild", (it) => {
  it.effect(
    "preserves native outputs while regenerating source, autolinking and bundle inputs",
    () =>
      Effect.gen(function* () {
        const { fs, mobile, file, regenerate } = yield* fixture;
        yield* prebuildAndroid(mobile, regenerate);
        assert.strictEqual(yield* fs.readFileString(file(".gradle/history")), ".gradle/history");
        assert.strictEqual(yield* fs.readFileString(file("app/.cxx/object")), "app/.cxx/object");
        assert.strictEqual(yield* fs.readFileString(file("new-source")), "new");
        for (const relative of ["obsolete-source", "build/autolinking", "app/build/bundle"]) {
          assert.isFalse(yield* fs.exists(file(relative)));
        }
        assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
      }),
  );

  it.effect("leaves caches behind symlinked directories at their original targets", () =>
    Effect.gen(function* () {
      for (const [relative, cache] of [
        ["", "app/.cxx/object"],
        ["app", ".cxx/object"],
        ["app/.cxx", "object"],
        [".gradle", "history"],
      ] as const) {
        const { fs, mobile, file, regenerate, path } = yield* fixture;
        const external = path.join(mobile, "external");
        const source = file(relative);
        yield* fs.rename(source, external);
        yield* fs.symlink(external, source);
        const cacheFile = path.join(external, cache);
        const before = yield* fs.readFileString(cacheFile);
        yield* prebuildAndroid(mobile, regenerate);
        assert.strictEqual(yield* fs.readFileString(cacheFile), before);
        assert.deepStrictEqual((yield* fs.readDirectory(mobile)).sort(), ["android", "external"]);
      }
    }),
  );

  it.effect("retains saved outputs when regeneration creates a symlinked cache parent", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate, path } = yield* fixture;
      const external = path.join(mobile, "external");
      yield* fs.makeDirectory(external);
      const linked = regenerate.pipe(Effect.andThen(fs.symlink(external, file("app"))));
      const error = yield* prebuildAndroid(mobile, linked).pipe(Effect.flip);
      const saved = (yield* fs.readDirectory(mobile)).find((name) =>
        name.startsWith(".android-prebuild-"),
      );
      assert.isDefined(saved);
      const recovery = path.join(mobile, saved!);
      assert.include(error.message, recovery);
      assert.strictEqual(
        yield* fs.readFileString(path.join(recovery, "app/.cxx/object")),
        "app/.cxx/object",
      );
      assert.deepStrictEqual(yield* fs.readDirectory(external), []);
    }),
  );

  it.effect("restores saved outputs when clean regeneration fails", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });
      const error = yield* prebuildAndroid(
        mobile,
        regenerate.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);
      assert.strictEqual(error, failure);
      assert.strictEqual(yield* fs.readFileString(file(".gradle/history")), ".gradle/history");
      assert.strictEqual(yield* fs.readFileString(file("app/.cxx/object")), "app/.cxx/object");
      assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
    }),
  );

  it.effect("leaves conflicting outputs and saved caches intact with a recovery path", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate, path } = yield* fixture;
      const conflict = regenerate.pipe(
        Effect.andThen(fs.makeDirectory(file(".gradle"))),
        Effect.andThen(fs.writeFileString(file(".gradle/new-history"), "new history")),
      );
      const error = yield* prebuildAndroid(mobile, conflict).pipe(Effect.flip);
      const saved = (yield* fs.readDirectory(mobile)).find((name) =>
        name.startsWith(".android-prebuild-"),
      );
      assert.isDefined(saved);
      const recovery = path.join(mobile, saved!);
      assert.include(error.message, recovery);
      assert.strictEqual(
        yield* fs.readFileString(path.join(recovery, ".gradle/history")),
        ".gradle/history",
      );
      assert.strictEqual(yield* fs.readFileString(file(".gradle/new-history")), "new history");
    }),
  );

  it.effect("recovers already moved caches when saving a later cache fails", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate } = yield* fixture;
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "save failed",
      });
      const savingFs = {
        ...fs,
        rename: (source: string, target: string) =>
          source === file("app/.cxx") ? Effect.fail(failure) : fs.rename(source, target),
      };
      const error = yield* prebuildAndroid(mobile, regenerate).pipe(
        Effect.provideService(FileSystem.FileSystem, savingFs),
        Effect.flip,
      );
      assert.strictEqual(error, failure);
      assert.strictEqual(yield* fs.readFileString(file(".gradle/history")), ".gradle/history");
      assert.strictEqual(yield* fs.readFileString(file("app/.cxx/object")), "app/.cxx/object");
      assert.strictEqual(yield* fs.readFileString(file("obsolete-source")), "old");
      assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
    }),
  );

  it.effect("retains saved outputs when a restore move fails", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate, path } = yield* fixture;
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "restore failed",
      });
      const restoringFs = {
        ...fs,
        rename: (source: string, target: string) =>
          target === file(".gradle") ? Effect.fail(failure) : fs.rename(source, target),
      };
      const error = yield* prebuildAndroid(mobile, regenerate).pipe(
        Effect.provideService(FileSystem.FileSystem, restoringFs),
        Effect.flip,
      );
      const saved = (yield* fs.readDirectory(mobile)).find((name) =>
        name.startsWith(".android-prebuild-"),
      );
      assert.isDefined(saved);
      const recovery = path.join(mobile, saved!);
      assert.include(error.message, recovery);
      assert.include(error.message, "restore failed");
      assert.strictEqual(
        yield* fs.readFileString(path.join(recovery, ".gradle/history")),
        ".gradle/history",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(recovery, "app/.cxx/object")),
        "app/.cxx/object",
      );
    }),
  );

  it.effect("preserves the original failure when cache recovery also fails", () =>
    Effect.gen(function* () {
      for (const phase of ["prebuild", "save"]) {
        const { fs, mobile, file, regenerate, path } = yield* fixture;
        const saveFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          description: "save failed",
        });
        const original =
          phase === "prebuild"
            ? new NativeClientError({ message: "prebuild failed" })
            : saveFailure;
        const restoreFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          description: "restore failed",
        });
        const failingFs = {
          ...fs,
          rename: (source: string, target: string) =>
            target === file(".gradle")
              ? Effect.fail(restoreFailure)
              : phase === "save" && source === file("app/.cxx")
                ? Effect.fail(saveFailure)
                : fs.rename(source, target),
        };
        const error = yield* prebuildAndroid(
          mobile,
          regenerate.pipe(Effect.andThen(Effect.fail(original))),
        ).pipe(Effect.provideService(FileSystem.FileSystem, failingFs), Effect.flip);
        assert.strictEqual(error, original);
        const saved = (yield* fs.readDirectory(mobile)).find((name) =>
          name.startsWith(".android-prebuild-"),
        );
        assert.isDefined(saved);
        const recovery = path.join(mobile, saved!);
        assert.strictEqual(
          yield* fs.readFileString(path.join(recovery, ".gradle/history")),
          ".gradle/history",
        );
        assert.isTrue(
          (yield* TestConsole.errorLines).some(
            (line) =>
              typeof line === "string" &&
              line.includes(recovery) &&
              line.includes("restore failed"),
          ),
        );
      }
    }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect("restores saved outputs when prebuild is interrupted", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate } = yield* fixture;
      const started = yield* Deferred.make<void>();
      const prebuild = regenerate.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
      );
      const fiber = yield* prebuildAndroid(mobile, prebuild).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(yield* fs.readFileString(file(".gradle/history")), ".gradle/history");
      assert.strictEqual(yield* fs.readFileString(file("app/.cxx/object")), "app/.cxx/object");
      assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
    }),
  );
  it.effect("prints the recovery path when interruption also prevents restoration", () =>
    Effect.gen(function* () {
      const { fs, mobile, file, regenerate, path } = yield* fixture;
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "restore failed",
      });
      const restoringFs = {
        ...fs,
        rename: (source: string, target: string) =>
          target === file(".gradle") ? Effect.fail(failure) : fs.rename(source, target),
      };
      const started = yield* Deferred.make<void>();
      const prebuild = regenerate.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
      );
      const fiber = yield* prebuildAndroid(mobile, prebuild).pipe(
        Effect.provideService(FileSystem.FileSystem, restoringFs),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const saved = (yield* fs.readDirectory(mobile)).find((name) =>
        name.startsWith(".android-prebuild-"),
      );
      assert.isDefined(saved);
      const recovery = path.join(mobile, saved!);
      assert.strictEqual(
        yield* fs.readFileString(path.join(recovery, ".gradle/history")),
        ".gradle/history",
      );
      assert.isTrue(
        (yield* TestConsole.errorLines).some(
          (line) => typeof line === "string" && line.includes(recovery),
        ),
      );
    }).pipe(Effect.provide(TestConsole.layer)),
  );
  it.effect(
    "keeps caches recoverable for every regeneration/completion/interruption ordering",
    () =>
      Effect.gen(function* () {
        const events = ["regenerate", "complete", "interrupt"] as const;
        const violations: string[] = [];
        for (const first of events) {
          for (const second of events.filter((event) => event !== first)) {
            const third = events.find((event) => event !== first && event !== second)!;
            for (const failRestore of [false, true]) {
              const { fs, mobile, file, regenerate, path } = yield* fixture;
              const entered = yield* Deferred.make<void>();
              const allowRegeneration = yield* Deferred.make<void>();
              const regenerated = yield* Deferred.make<void>();
              const allowCompletion = yield* Deferred.make<void>();
              const failure = PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
              });
              const restoringFs = {
                ...fs,
                rename: (source: string, target: string) =>
                  failRestore && target === file(".gradle")
                    ? Effect.fail(failure)
                    : fs.rename(source, target),
              };
              const prebuild = Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(allowRegeneration);
                yield* regenerate;
                yield* Deferred.succeed(regenerated, undefined);
                yield* Deferred.await(allowCompletion);
              });
              const fiber = yield* prebuildAndroid(mobile, prebuild).pipe(
                Effect.provideService(FileSystem.FileSystem, restoringFs),
                Effect.forkChild,
              );
              yield* Deferred.await(entered);
              let completed = false;
              let released = false;
              let cleaned = false;
              const sequence = [first, second, third];
              for (const event of sequence) {
                if (event === "interrupt") {
                  yield* Fiber.interrupt(fiber);
                  completed = true;
                } else if (event === "regenerate") {
                  yield* Deferred.succeed(allowRegeneration, undefined);
                  if (!completed) {
                    yield* Deferred.await(regenerated);
                    cleaned = true;
                    if (released) {
                      yield* Fiber.await(fiber);
                      completed = true;
                    }
                  }
                } else {
                  yield* Deferred.succeed(allowCompletion, undefined);
                  released = true;
                  if (cleaned && !completed) {
                    yield* Fiber.await(fiber);
                    completed = true;
                  }
                }
              }
              const saved = (yield* fs.readDirectory(mobile)).find((name) =>
                name.startsWith(".android-prebuild-"),
              );
              const recovery = saved ? path.join(mobile, saved) : path.join(mobile, "android");
              for (const [relative, expected] of [
                [".gradle/history", ".gradle/history"],
                ["app/.cxx/object", "app/.cxx/object"],
              ] as const) {
                const output = path.join(recovery, relative);
                if (
                  !(yield* fs.exists(output)) ||
                  (yield* fs.readFileString(output)) !== expected
                ) {
                  violations.push(
                    `lost ${relative}: ${sequence.join(" -> ")}, restore failure=${failRestore}`,
                  );
                }
              }
              if (
                saved &&
                !(yield* TestConsole.errorLines).some(
                  (line) => typeof line === "string" && line.includes(recovery),
                )
              ) {
                violations.push(
                  `missing recovery path: ${sequence.join(" -> ")}, restore failure=${failRestore}`,
                );
              }
            }
          }
        }
        assert.deepStrictEqual(violations, []);
      }).pipe(Effect.provide(TestConsole.layer)),
  );
});
