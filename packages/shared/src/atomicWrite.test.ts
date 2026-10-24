import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as HostProcess from "./HostProcess.ts";

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), "../config/settings.json");
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const stale = yield* writeFileStringAtomically({ filePath, contents: "stale" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      // Another process saves once the lock clears, before the waiting write retries.
      yield* writeFileStringAtomically({ filePath, contents: "newer" });

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  // Read-only and write-only targets replace fine in a writable directory, so the
  // narrowed mode lands only after the temp file is open for writing.
  it.effect.each(
    HostProcess.Platform.defaultValue() === "win32"
      ? []
      : ["644", "600", "444", "400", "200", "000"],
  )("keeps the %s permissions of the file it replaces", (octal) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      const mode = Number.parseInt(octal, 8);
      yield* fs.writeFileString(filePath, "before");
      yield* fs.chmod(filePath, mode);

      yield* writeFileStringAtomically({ filePath, contents: "after" });

      assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, mode);
      yield* fs.chmod(filePath, 0o600);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "creates a new file readable only by its owner",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: "fresh" });

        assert.strictEqual(((yield* fs.stat(filePath)).mode & 0o777).toString(8), "600");
      }),
  );

  it.effect("syncs the contents before the rename and the directory after it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      const events: Array<string> = [];
      const recording = FileSystem.make({
        ...fs,
        open: (openedPath, options) =>
          fs.open(openedPath, options).pipe(
            // The real handle keeps its methods on its prototype, so it is extended, not spread.
            Effect.map((file): FileSystem.File =>
              Object.create(file, {
                sync: {
                  value: file.sync.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        events.push(openedPath === root ? "sync directory" : "sync temp file");
                      }),
                    ),
                  ),
                },
              }),
            ),
          ),
        rename: (from, to) =>
          fs
            .rename(from, to)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  events.push(from === filePath ? "rename target" : "rename temp file"),
                ),
              ),
            ),
      });

      yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording),
      );

      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      // Windows cannot open a directory to sync it.
      assert.deepStrictEqual(
        events,
        HostProcess.Platform.defaultValue() === "win32"
          ? ["sync temp file", "rename temp file"]
          : ["sync temp file", "rename temp file", "sync directory"],
      );
    }),
  );
  // EIO means the rename may not survive a crash. ENOTSUP means the filesystem
  // cannot sync a directory at all, so the save stands.
  it.effect.each(
    HostProcess.Platform.defaultValue() === "win32"
      ? []
      : [
          { code: "EIO", fails: true },
          { code: "ENOTSUP", fails: false },
        ],
  )("handles a directory sync failing with $code after the rename", ({ code, fails }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      const syncFailure = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "sync",
        pathOrDescriptor: root,
        cause: Object.assign(new Error(`${code}, fsync`), { code }),
      });
      const failingDirectorySync = FileSystem.make({
        ...fs,
        open: (openedPath, options) =>
          fs
            .open(openedPath, options)
            .pipe(
              Effect.map((file): FileSystem.File =>
                openedPath === root
                  ? Object.create(file, { sync: { value: Effect.fail(syncFailure) } })
                  : file,
              ),
            ),
      });

      const exit = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingDirectorySync),
        Effect.exit,
      );

      assert.deepStrictEqual(exit, fails ? Exit.fail(syncFailure) : Exit.void);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
    }),
  );

  // A directory that cannot be opened to sync it has to fail the save before the
  // rename rather than after it. The failure is injected because root ignores a
  // chmod that drops read access.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "leaves the target intact when its directory cannot be opened for the sync",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");
        yield* fs.writeFileString(filePath, "before");
        const openFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "open",
          pathOrDescriptor: root,
        });
        const unopenableDirectory = FileSystem.make({
          ...fs,
          open: (openedPath, options) =>
            openedPath === root ? Effect.fail(openFailure) : fs.open(openedPath, options),
        });

        const exit = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
          Effect.provideService(FileSystem.FileSystem, unopenableDirectory),
          Effect.exit,
        );

        assert.deepStrictEqual(exit, Exit.fail(openFailure));
        assert.strictEqual(yield* fs.readFileString(filePath), "before");
      }),
  );

  it.effect("succeeds when the write lands but its temp directory cannot be removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      const removeAttempts: Array<string> = [];
      const unremovable = FileSystem.make({
        ...fs,
        remove: (removedPath) =>
          Effect.suspend(() => {
            removeAttempts.push(removedPath);
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: removedPath,
              }),
            );
          }),
      });

      yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, unremovable),
      );

      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.strictEqual(removeAttempts.length, 1);
      assert.deepStrictEqual(
        (yield* fs.readDirectory(root)).toSorted(),
        [path.basename(removeAttempts[0]!), "settings.json"].toSorted(),
      );
    }),
  );
});

// Retries stat the real target between waits, and that I/O finishes outside the
// test clock, so the clock moves one wait at a time until the write settles.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a macrotask boundary so the real stat I/O can finish; time moves only via TestClock
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  });

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
  });

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const failure = yield* writeFileStringAtomically({
      filePath: "/home/settings.json",
      contents: "after",
    }).pipe(Effect.flip);

    assert.deepStrictEqual(failure, readLinkFailure);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);
