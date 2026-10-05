import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Cleanup from "./KiloProcessCleanup.ts";

const stat = (state = "S", start = "123") => {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[2] = "4242";
  fields[19] = start;
  return `4242 (fixture child) ${fields.join(" ")}`;
};
const records = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const directories = yield* fs.readDirectory(`${root}/kilo-cleanup`);
    return (yield* Effect.forEach(directories, (name) =>
      fs.readDirectory(`${root}/kilo-cleanup/${name}`),
    )).flat();
  });
const denied = () =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: "/proc/4242/stat",
  });
const missing = () =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: "/proc/4242/stat",
  });

it.effect.each(["zombie", "gone", "reused", "permission", "malformed"] as const)(
  "verifies %s without treating observation failure as absence",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let stopped = false;
      let repaired = false;
      let starts = 0;
      const fake: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (path) =>
          path === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(path),
        readFileString: (path, ...args) =>
          path !== "/proc/4242/stat"
            ? fs.readFileString(path, ...args)
            : Effect.suspend(() => {
                if (!stopped) return Effect.succeed(stat());
                if (repaired || outcome === "zombie") return Effect.succeed(stat("Z"));
                if (outcome === "gone") return Effect.fail(missing());
                if (outcome === "reused") return Effect.succeed(stat("S", "456"));
                if (outcome === "permission") return Effect.fail(denied());
                return Effect.succeed("invalid stat");
              }),
      };
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
        const result = yield* Effect.exit(
          cleanup.verify(
            4242,
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        );
        const bad = outcome === "permission" || outcome === "malformed";
        assert.equal(Exit.isFailure(result), bad);
        // A new helper reads the real on-disk record, not the first helper's closure.
        const reopened = yield* Cleanup.make({ profile: root, stateDir: root });
        const start = reopened.withStart(Effect.sync(() => ++starts));
        const admission = yield* Effect.exit(start);
        assert.equal(Exit.isFailure(admission), bad);
        assert.equal(starts, bad ? 0 : 1);
        if (bad) {
          assert.deepEqual(yield* records(fs, root), ["4242.json"]);
          repaired = true;
          yield* start;
          assert.equal(starts, 1);
        }
        assert.deepEqual(yield* records(fs, root), []);
      }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("timeout retains the recorded identities and recovery requires observed exit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const stopping = yield* Deferred.make<void>();
    let state = "S";
    const fake: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (p) => (p === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(p)),
      readFileString: (p, ...a) =>
        p === "/proc/4242/stat" ? Effect.sync(() => stat(state)) : fs.readFileString(p, ...a),
    };
    yield* Effect.gen(function* () {
      const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
      const fiber = yield* cleanup
        .verify(4242, Deferred.succeed(stopping, undefined).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(stopping);
      yield* TestClock.adjust("3 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(yield* records(fs, root), ["4242.json"]);
      state = "Z";
      let starts = 0;
      yield* cleanup.withStart(Effect.sync(() => starts++));
      assert.equal(starts, 1);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a failed reservation write cannot be bypassed by a successful directory read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let writesFail = true;
    let state = "S";
    let signals = 0;
    let starts = 0;
    const fake: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (p) => (p === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(p)),
      readFileString: (p, ...args) =>
        p === "/proc/4242/stat" ? Effect.sync(() => stat(state)) : fs.readFileString(p, ...args),
      writeFileString: (p, ...args) =>
        writesFail && p.endsWith("4242.json.tmp")
          ? Effect.fail(denied())
          : fs.writeFileString(p, ...args),
    };
    yield* Effect.gen(function* () {
      const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
      yield* cleanup
        .verify(
          4242,
          Effect.sync(() => signals++),
        )
        .pipe(Effect.flip);
      writesFail = false;
      const replacement = yield* Cleanup.make({ profile: root, stateDir: root });
      yield* replacement.withStart(Effect.sync(() => starts++)).pipe(Effect.flip);
      assert.equal(signals, 0);
      assert.equal(starts, 0);
      // An unrelated profile is not blocked by this profile's storage failure.
      const other = yield* Cleanup.make({
        profile: `${root}/other`,
        stateDir: root,
      });
      yield* other.withStart(Effect.sync(() => starts++));
      assert.equal(starts, 1);
      state = "Z";
      yield* replacement.withStart(Effect.sync(() => starts++));
      assert.equal(starts, 2);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("incomplete snapshots recover only after a complete quiescent-group observation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let unreadable = true;
    let state = "S";
    let starts = 0;
    const fake: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (p) => (p === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(p)),
      readFileString: (p, ...args) =>
        p === "/proc/4242/stat"
          ? Effect.suspend(() => (unreadable ? Effect.fail(denied()) : Effect.succeed(stat(state))))
          : fs.readFileString(p, ...args),
    };
    yield* Effect.gen(function* () {
      const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
      yield* cleanup
        .verify(4242, Effect.die("must not signal without observation"))
        .pipe(Effect.flip);
      const reopened = yield* Cleanup.make({ profile: root, stateDir: root });
      const start = reopened.withStart(Effect.sync(() => starts++));
      yield* start.pipe(Effect.flip);
      unreadable = false;
      yield* start.pipe(Effect.flip);
      assert.equal(starts, 0);
      state = "Z";
      yield* start;
      assert.equal(starts, 1);
      assert.deepEqual(yield* records(fs, root), []);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "first-open profile aliases share pending cleanup and preserve other account admission",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/real`);
      yield* fs.symlink(`${root}/real`, `${root}/alias`);
      let unreadable = false;
      let state = "S";
      const fake: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (p) => (p === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(p)),
        readFileString: (p, ...args) =>
          p === "/proc/4242/stat"
            ? Effect.suspend(() =>
                unreadable ? Effect.fail(denied()) : Effect.succeed(stat(state)),
              )
            : fs.readFileString(p, ...args),
      };
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.make({
          profile: `${root}/alias/new-profile`,
          stateDir: root,
        });
        yield* cleanup
          .verify(
            4242,
            Effect.sync(() => {
              unreadable = true;
            }),
          )
          .pipe(Effect.flip);
        const reopened = yield* Cleanup.make({
          profile: `${root}/real/new-profile`,
          stateDir: root,
        });
        let starts = 0;
        yield* reopened.withStart(Effect.sync(() => starts++)).pipe(Effect.flip);
        assert.equal(starts, 0);
        // Even a malformed pending record in one account must not block another.
        const [key] = yield* fs.readDirectory(`${root}/kilo-cleanup`);
        const file = `${root}/kilo-cleanup/${key}/4242.json`;
        const saved = yield* fs.readFileString(file);
        yield* fs.writeFileString(file, "incomplete write");
        const other = yield* Cleanup.make({ profile: `${root}/other`, stateDir: root });
        yield* other.withStart(Effect.sync(() => starts++));
        assert.equal(starts, 1);
        yield* fs.writeFileString(file, saved);
        unreadable = false;
        state = "Z";
        yield* reopened.withStart(Effect.sync(() => starts++));
        assert.equal(starts, 2);
      }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancellation releases the lock but preserves uncertainty until observed exit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const entered = yield* Deferred.make<void>();
    let park = true;
    let state = "S";
    const fake: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (p) =>
        p === "/proc"
          ? Effect.suspend(() =>
              park
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(["4242"]),
            )
          : fs.readDirectory(p),
      readFileString: (p, ...args) =>
        p === "/proc/4242/stat" ? Effect.sync(() => stat(state)) : fs.readFileString(p, ...args),
    };
    yield* Effect.gen(function* () {
      const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
      const fiber = yield* cleanup.verify(4242, Effect.void).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      park = false;
      let starts = 0;
      const reopened = yield* Cleanup.make({ profile: root, stateDir: root });
      yield* reopened.withStart(Effect.sync(() => starts++)).pipe(Effect.flip);
      assert.equal(starts, 0);
      state = "Z";
      yield* reopened.withStart(Effect.sync(() => starts++));
      assert.equal(starts, 1);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "holds the shared gate through observation and exit, without serializing session lifetime",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const scanning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const observedAlive = yield* Deferred.make<void>();
      let signalled = false;
      const events: Array<string> = [];
      let state = "S";
      const fake: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (p) =>
          p === "/proc"
            ? Deferred.succeed(scanning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(["4242"]),
              )
            : fs.readDirectory(p),
        readFileString: (p, ...args) =>
          p === "/proc/4242/stat"
            ? Effect.sync(() => {
                const value = stat(state);
                if (state === "Z") events.push("confirmed");
                else if (signalled) Deferred.doneUnsafe(observedAlive, Effect.void);
                return value;
              })
            : fs.readFileString(p, ...args),
      };
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
        const other = yield* Cleanup.make({ profile: root, stateDir: root });
        const stopping = yield* cleanup
          .verify(
            4242,
            Effect.sync(() => {
              signalled = true;
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(scanning);
        const replacement = yield* Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(other.withStart(Effect.sync(() => events.push("spawn")))),
          Effect.forkScoped,
        );
        yield* Deferred.await(requested);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(observedAlive);
        assert.deepEqual(events, []);
        state = "Z";
        yield* TestClock.adjust("10 millis");
        yield* Fiber.join(stopping);
        yield* Fiber.join(replacement);
        assert.deepEqual(events, ["confirmed", "spawn"]);
        yield* other.withStart(Effect.sync(() => events.push("parallel-session")));
        assert.equal(events.at(-1), "parallel-session");
      }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a partial snapshot write preserves a readable uncertainty record for recovery", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let writes = 0;
    let state = "S";
    const fake: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (p) => (p === "/proc" ? Effect.succeed(["4242"]) : fs.readDirectory(p)),
      readFileString: (p, ...args) =>
        p === "/proc/4242/stat" ? Effect.sync(() => stat(state)) : fs.readFileString(p, ...args),
      writeFileString: (p, ...args) =>
        Effect.suspend(() => {
          if (p.endsWith(".tmp") && ++writes === 2)
            return fs.writeFileString(p, "{partial").pipe(Effect.andThen(Effect.fail(denied())));
          return fs.writeFileString(p, ...args);
        }),
    };
    yield* Effect.gen(function* () {
      const cleanup = yield* Cleanup.make({ profile: root, stateDir: root });
      yield* cleanup.verify(4242, Effect.die("no signal after partial write")).pipe(Effect.flip);
      const reopened = yield* Cleanup.make({ profile: root, stateDir: root });
      let starts = 0;
      const start = reopened.withStart(Effect.sync(() => starts++));
      yield* start.pipe(Effect.flip);
      assert.equal(starts, 0);
      state = "Z";
      yield* start;
      assert.equal(starts, 1);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fake));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
