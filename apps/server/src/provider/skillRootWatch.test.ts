import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { isSkillListChange, watchSkillRoot } from "./skillRootWatch.ts";

// A filesystem whose watch streams replay queued events and then end, so each
// test controls exactly which events a root reports.
const makeWatchFileSystem = (options: {
  readonly exists: (path: string) => boolean;
  readonly events: ReadonlyMap<string, ReadonlyArray<FileSystem.WatchEvent>>;
}) =>
  Effect.gen(function* () {
    const watched: Array<{ readonly path: string; readonly recursive: boolean }> = [];
    const queues = new Map<string, Queue.Queue<FileSystem.WatchEvent, Cause.Done>>();
    for (const [path, events] of options.events) {
      const queue = yield* Queue.unbounded<FileSystem.WatchEvent, Cause.Done>();
      yield* Queue.offerAll(queue, events);
      yield* Queue.end(queue);
      queues.set(path, queue);
    }
    const fileSystem = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(options.exists(path)),
      watch: (path, watchOptions) => {
        watched.push({ path, recursive: watchOptions?.recursive ?? false });
        const queue = queues.get(path);
        return queue ? Stream.fromQueue(queue) : Stream.empty;
      },
    });
    return { fileSystem, watched };
  });

describe("skillRootWatch", () => {
  it("counts only changes that can alter a skill list", () => {
    for (const path of [
      "new-skill",
      "linked-skill",
      "new-skill/SKILL.md",
      "new-skill\\SKILL.md",
      // Any directory name can hold a skill.
      ".hidden-skill",
      "release.tmp",
      "release~",
      "4913",
      // Codex also loads skills nested below a root.
      "new-skill/references/SKILL.md",
      "group/nested-skill/SKILL.md",
      ".system/imagegen/SKILL.md",
    ]) {
      assert.isTrue(isSkillListChange(path), path);
    }
    for (const path of [
      "",
      "new-skill/scripts/run.sh",
      "new-skill/assets",
      "new-skill/README.md",
      "new-skill/.SKILL.md.swp",
      "new-skill/SKILL.md~",
    ]) {
      assert.isFalse(isSkillListChange(path), path);
    }
  });

  const watchCount = (
    watched: ReadonlyArray<{ readonly path: string; readonly recursive: boolean }>,
    path: string,
    recursive: boolean,
  ) => watched.filter((entry) => entry.path === path && entry.recursive === recursive).length;

  it.effect("watches an existing root recursively and drops unrelated events", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = path.resolve("/home/user/.claude/skills");
      const { fileSystem, watched } = yield* makeWatchFileSystem({
        exists: (candidate) => candidate === root,
        events: new Map([
          [
            root,
            [
              { _tag: "Update", path: "existing/scripts/run.sh" },
              { _tag: "Create", path: "existing/.SKILL.md.swp" },
              { _tag: "Update", path: "existing/SKILL.md" },
              { _tag: "Create", path: "new-skill" },
            ],
          ],
        ]),
      });

      const emitted = yield* watchSkillRoot(root).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      assert.strictEqual(emitted.length, 2);
      // A watch that ends on its own is not started again.
      assert.strictEqual(watchCount(watched, root, true), 1);
      assert.strictEqual(watchCount(watched, path.dirname(root), false), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("watches a replaced root again", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = path.resolve("/home/user/.claude");
      const root = path.join(parent, "skills");
      const { fileSystem, watched } = yield* makeWatchFileSystem({
        exists: (candidate) => candidate === root,
        events: new Map([[parent, [{ _tag: "Remove", path: "skills" }]]]),
      });

      yield* watchSkillRoot(root).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      assert.strictEqual(watchCount(watched, root, true), 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a root that vanishes before its watch starts", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = path.resolve("/home/user/.claude");
      const root = path.join(parent, "skills");
      const existing = new Set([parent, root]);
      const { fileSystem: base, watched } = yield* makeWatchFileSystem({
        exists: (candidate) => existing.has(candidate),
        events: new Map(),
      });
      const fileSystem: FileSystem.FileSystem = {
        ...base,
        watch: (watchedPath, options) => {
          if (watchedPath !== root) return base.watch(watchedPath, options);
          existing.delete(root);
          return Stream.concat(
            base.watch(watchedPath, options).pipe(Stream.take(0)),
            Stream.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "watch",
                pathOrDescriptor: root,
              }),
            ),
          );
        },
      };

      const emitted = yield* watchSkillRoot(root).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      assert.strictEqual(emitted.length, 1);
      // Once as the root's parent, then as the missing root's nearest ancestor.
      assert.strictEqual(watchCount(watched, parent, false), 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a missing root down from its nearest existing ancestor", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repository = path.resolve("/repo");
      const claudeDirectory = path.join(repository, ".claude");
      const root = path.join(claudeDirectory, "skills");
      // Each watched directory gains the entry its queued event reports.
      const existing = new Set([repository]);
      const { fileSystem: base, watched } = yield* makeWatchFileSystem({
        exists: (candidate) => existing.has(candidate),
        events: new Map([
          [
            repository,
            [
              { _tag: "Create", path: "README.md" },
              { _tag: "Create", path: ".claude" },
            ],
          ],
          [claudeDirectory, [{ _tag: "Create", path: "skills" }]],
          [root, [{ _tag: "Create", path: "first-skill" }]],
        ]),
      });
      const created = new Map([
        [repository, claudeDirectory],
        [claudeDirectory, root],
      ]);
      const fileSystem: FileSystem.FileSystem = {
        ...base,
        watch: (target, options) => {
          const entry = created.get(target);
          if (entry !== undefined) existing.add(entry);
          return base.watch(target, options);
        },
      };

      const emitted = yield* watchSkillRoot(root).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      // `.claude` appeared, `skills` appeared, then the first skill.
      assert.strictEqual(emitted.length, 3);
      assert.strictEqual(watchCount(watched, repository, false), 1);
      assert.strictEqual(watchCount(watched, root, true), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never watches a home directory or filesystem root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.resolve(NodeOS.homedir());
      const { fileSystem, watched } = yield* makeWatchFileSystem({
        exists: (candidate) => candidate === home || path.dirname(candidate) === candidate,
        events: new Map(),
      });

      for (const root of [
        path.join(home, ".agents-missing", "skills"),
        path.resolve("/missing-top-level/.claude/skills"),
      ]) {
        const emitted = yield* watchSkillRoot(root).pipe(
          Stream.runCollect,
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        assert.strictEqual(emitted.length, 0);
      }
      assert.deepStrictEqual(watched, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
