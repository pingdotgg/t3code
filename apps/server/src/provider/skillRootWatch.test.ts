import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
    for (const path of ["new-skill", "linked-skill", "new-skill/SKILL.md", "new-skill\\SKILL.md"]) {
      assert.isTrue(isSkillListChange(path), path);
    }
    for (const path of [
      "",
      "new-skill/scripts/run.sh",
      "new-skill/assets",
      "new-skill/README.md",
      "new-skill/references/SKILL.md",
      ".system",
      ".system/imagegen/SKILL.md",
      ".DS_Store",
      "new-skill/.SKILL.md.swp",
      "SKILL.md~",
      "4913",
      "draft.tmp",
    ]) {
      assert.isFalse(isSkillListChange(path), path);
    }
  });

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
              { _tag: "Create", path: ".DS_Store" },
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
      assert.deepStrictEqual(watched, [{ path: root, recursive: true }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("watches a missing root through its parent until it is created", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = path.resolve("/home/user/.agents");
      const root = path.join(parent, "skills");
      let rootChecks = 0;
      const { fileSystem, watched } = yield* makeWatchFileSystem({
        // Missing on the first check, present once the parent reports it.
        exists: (candidate) => candidate === parent || (candidate === root && rootChecks++ > 0),
        events: new Map([
          [
            parent,
            [
              { _tag: "Create", path: "other" },
              { _tag: "Create", path: "skills" },
            ],
          ],
          [root, [{ _tag: "Create", path: "new-skill" }]],
        ]),
      });

      const emitted = yield* watchSkillRoot(root).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      assert.strictEqual(emitted.length, 2);
      assert.deepStrictEqual(watched, [
        { path: parent, recursive: false },
        { path: root, recursive: true },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not watch above a missing parent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { fileSystem, watched } = yield* makeWatchFileSystem({
        exists: () => false,
        events: new Map(),
      });

      const emitted = yield* watchSkillRoot(path.resolve("/repo/.claude/skills")).pipe(
        Stream.runCollect,
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      assert.strictEqual(emitted.length, 0);
      assert.deepStrictEqual(watched, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
