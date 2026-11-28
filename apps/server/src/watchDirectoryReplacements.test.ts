import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { watchDirectoryPath } from "./watchDirectoryReplacements.ts";

// Watches under this root open but report only what a test sends, as a macOS watch can stay
// silent before it is armed. Their paths resolve to themselves unless linked or missing.
const silent = vi.hoisted(() => ({
  root: "/silent-watch",
  owns(path: unknown): path is string {
    return (
      typeof path === "string" &&
      (path === this.root || path.startsWith(`${this.root}/`) || path.startsWith(`${this.root}\\`))
    );
  },
  links: new Map<string, string>(),
  missing: new Set<string>(),
  listeners: new Map<string, (event: string, filename: string | null) => void>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = (...args: Parameters<typeof actual.watch>) => {
    const [path, listener] = args;
    if (!silent.owns(path)) return actual.watch(...args);
    const report = listener as (event: string, filename: string | null) => void;
    silent.listeners.set(path, report);
    return {
      on: () => undefined,
      close: () => silent.listeners.get(path) === report && silent.listeners.delete(path),
    };
  };
  const native = (...args: Parameters<typeof actual.realpath.native>) => {
    const [path, callback] = args;
    if (!silent.owns(path)) return actual.realpath.native(...args);
    if (silent.missing.has(path)) {
      return callback(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }), "");
    }
    return callback(null, silent.links.get(path) ?? path);
  };
  return { ...actual, watch, realpath: Object.assign(actual.realpath.bind(undefined), { native }) };
});

it.live.each(["linked", "plain"] as const)(
  "backs off stopped watches for an unchanged %s directory",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const entry = path.join(base, "linked");
      const first = path.join(base, "first", "themes");
      const second = path.join(base, "second", "themes");
      yield* fs.makeDirectory(first, { recursive: true });
      yield* fs.makeDirectory(second, { recursive: true });
      if (kind === "linked" && !symlinksSupported) return;
      yield* kind === "linked" ? fs.symlink(first, entry) : fs.makeDirectory(entry);
      const firstIdentity = yield* fs.stat(first);
      const secondIdentity = yield* fs.stat(second);
      let identity = firstIdentity;
      const events = yield* Queue.unbounded<"probe" | "refresh">();

      // An ended child emits a final refresh, as it does when registration fails.
      yield* watchDirectoryPath(entry, Stream.succeed(undefined), Effect.succeed(false)).pipe(
        Stream.runForEach(() => Queue.offer(events, "refresh")),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            stat: (file) =>
              file === entry
                ? Queue.offer(events, "probe").pipe(Effect.map(() => identity))
                : fs.stat(file),
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepEqual(
        yield* Queue.takeN(events, 10),
        // Each acquire stats too: the first, a retry after 1 tick, then after 2 more.
        [
          "probe",
          "probe",
          "refresh",
          "probe",
          "probe",
          "refresh",
          "probe",
          "probe",
          "probe",
          "refresh",
        ],
      );

      identity = secondIdentity;
      assert.deepEqual(yield* Queue.takeN(events, 3), ["probe", "probe", "refresh"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(!symlinksSupported)(
  "rebuilds when a probe sees a tree other than the one the watches were acquired on",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const entry = path.join(base, "linked");
      const first = path.join(base, "first");
      const second = path.join(base, "second");
      yield* fs.makeDirectory(first);
      yield* fs.makeDirectory(second);
      yield* fs.symlink(first, entry);
      const a = yield* fs.stat(first);
      const b = yield* fs.stat(second);
      // Probe A, acquire A, probe B, swap back and acquire A, then B returns for the next probe.
      const identities = [a, a, b, a, b, b];
      const refreshes = yield* Queue.unbounded<void>();

      yield* watchDirectoryPath(
        entry,
        Stream.concat(Stream.succeed(undefined), Stream.never),
        Effect.succeed(false),
      ).pipe(
        Stream.runForEach(() => Queue.offer(refreshes, undefined)),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            stat: (file) =>
              file === entry ? Effect.sync(() => identities.shift() ?? b) : fs.stat(file),
          }),
        ),
        Effect.forkScoped,
      );
      yield* Queue.takeN(refreshes, 3);
      assert.deepEqual(identities, []);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "another directory", folder: "elsewhere", linkedStat: "other" },
  { name: "a directory that is gone", folder: "gone", linkedStat: "missing" },
] as const)(
  "follows a directory replaced by a link to $name when its parent watch reports nothing",
  ({ folder, linkedStat }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const plain = yield* fs.stat(yield* fs.makeTempDirectoryScoped());
      const other = yield* fs.stat(yield* fs.makeTempDirectoryScoped());
      silent.root = path.resolve("/silent-watch", folder);
      const entry = path.join(silent.root, "userdata", "themes");
      const target = path.join(silent.root, folder, "themes");
      let linked = false;
      const acquisitions = yield* Queue.unbounded<void>();
      const fail = (method: string, _tag: "InvalidData" | "NotFound") =>
        Effect.fail(
          PlatformError.systemError({
            _tag,
            module: "FileSystem",
            method,
            pathOrDescriptor: entry,
          }),
        );
      silent.links.clear();
      silent.missing.clear();

      yield* watchDirectoryPath(
        entry,
        Stream.fromEffect(Effect.asVoid(Queue.offer(acquisitions, undefined))).pipe(
          Stream.concat(Stream.never),
        ),
        Effect.succeed(false),
      ).pipe(
        Stream.runDrain,
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            // The watcher reuses the effects it builds, so each run reads the fixture afresh.
            readLink: (file) =>
              silent.owns(file)
                ? Effect.suspend(() =>
                    file === entry && linked
                      ? Effect.succeed(target)
                      : fail("readLink", "InvalidData"),
                  )
                : fs.readLink(file),
            stat: (file) =>
              file !== entry
                ? fs.stat(file)
                : Effect.suspend(() =>
                    !linked
                      ? Effect.succeed(plain)
                      : linkedStat === "other"
                        ? Effect.succeed(other)
                        : fail("stat", "NotFound"),
                  ),
          }),
        ),
        Effect.forkScoped,
      );
      yield* Queue.take(acquisitions);

      // Replaced by a link with no parent event: only the next probe can see it.
      linked = true;
      silent.links.set(entry, target);
      if (linkedStat === "missing") silent.missing.add(entry);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.size(acquisitions), 1);
      yield* Queue.take(acquisitions);

      // The link target's parent is watched now: replacing the target rearms its contents.
      const targetParent = silent.listeners.get(path.dirname(target));
      assert.isDefined(targetParent);
      targetParent("rename", path.basename(target));
      yield* Queue.take(acquisitions);
    }).pipe(Effect.provide(NodeServices.layer)),
);
