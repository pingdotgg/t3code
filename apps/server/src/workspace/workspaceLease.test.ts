// @effect-diagnostics nodeBuiltinImport:off - Effect's Path has no win32 implementation for the Windows lease test.
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodePath from "node:path";

import { withWorkspaceLease } from "./workspaceLease.ts";

// Synchronous real paths keep lease acquisition synchronous, so a forked
// contender has either entered or queued by the time `forkChild` returns.
const realPaths = new Map([
  ["/repo", "/repo"],
  ["/repo/worktree", "/repo/worktree"],
  ["/repo/worktree-2", "/repo/worktree-2"],
  ["/alias", "/repo/worktree"],
  ["/home-link", "/repo"],
]);
const missing = FileSystem.makeNoop({});
const testLayer = Layer.mergeAll(
  FileSystem.layerNoop({
    realPath: (path) => {
      const real = realPaths.get(path);
      return real === undefined ? missing.realPath(path) : Effect.succeed(real);
    },
  }),
  Path.layer,
);

// Windows realPath resolves existing paths but keeps the caller's letter case.
const windowsLayer = Layer.mergeAll(
  FileSystem.layerNoop({
    realPath: (path) =>
      path.toLowerCase().startsWith("c:\\users\\me\\repo") &&
      !path.toLowerCase().includes("packages")
        ? Effect.succeed(path)
        : missing.realPath(path),
  }),
  Layer.succeed(Path.Path)(
    Path.make({
      ...NodePath.win32,
      fromFileUrl: () => Effect.die("unused"),
      toFileUrl: () => Effect.die("unused"),
    }),
  ),
);

const holdLease = Effect.fn(function* (cwd: string) {
  const release = yield* Deferred.make<void>();
  const fiber = yield* withWorkspaceLease(cwd, Deferred.await(release)).pipe(
    Effect.forkChild({ startImmediately: true }),
  );
  return { release: Deferred.succeed(release, undefined), fiber };
});

const enterLease = Effect.fn(function* (cwd: string, entered: string[]) {
  return yield* withWorkspaceLease(
    cwd,
    Effect.sync(() => entered.push(cwd)),
  ).pipe(Effect.forkChild({ startImmediately: true }));
});

describe("withWorkspaceLease", () => {
  it.effect.each([
    { label: "a symlink alias", contenderPath: "/alias" },
    { label: "a parent directory", contenderPath: "/repo" },
    { label: "a missing child directory", contenderPath: "/repo/worktree/packages/app" },
    { label: "a removed worktree under a symlinked parent", contenderPath: "/home-link/worktree" },
  ])("makes $label wait for the checkout's lease", ({ contenderPath }) =>
    Effect.gen(function* () {
      const entered: string[] = [];
      const holder = yield* holdLease("/repo/worktree");
      const contender = yield* enterLease(contenderPath, entered);
      assert.deepEqual(entered, []);

      yield* holder.release;
      yield* Fiber.join(holder.fiber);
      yield* Fiber.join(contender);
      assert.deepEqual(entered, [contenderPath]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("matches Windows paths that differ only in letter case", () =>
    Effect.gen(function* () {
      const entered: string[] = [];
      const holder = yield* holdLease("C:\\Users\\me\\repo");
      const contender = yield* enterLease("c:\\users\\me\\REPO\\packages", entered);
      assert.deepEqual(entered, []);

      yield* holder.release;
      yield* Fiber.join(holder.fiber);
      yield* Fiber.join(contender);
      assert.deepEqual(entered, ["c:\\users\\me\\REPO\\packages"]);
    }).pipe(Effect.provide(windowsLayer)),
  );

  it.effect("does not make a sibling sharing the path prefix wait", () =>
    Effect.gen(function* () {
      const entered: string[] = [];
      const holder = yield* holdLease("/repo/worktree");
      yield* Fiber.join(yield* enterLease("/repo/worktree-2", entered));
      assert.deepEqual(entered, ["/repo/worktree-2"]);
      yield* holder.release;
      yield* Fiber.join(holder.fiber);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("grants overlapping leases in arrival order and skips interrupted waiters", () =>
    Effect.gen(function* () {
      const entered: string[] = [];
      const holder = yield* holdLease("/repo/worktree");
      const interrupted = yield* enterLease("/repo", entered);
      const queuedParent = yield* holdLease("/repo");
      const queuedChild = yield* enterLease("/repo/worktree", entered);

      yield* Fiber.interrupt(interrupted);
      yield* holder.release;
      yield* Fiber.join(holder.fiber);
      assert.deepEqual(entered, []);

      yield* queuedParent.release;
      yield* Fiber.join(queuedParent.fiber);
      yield* Fiber.join(queuedChild);
      assert.deepEqual(entered, ["/repo/worktree"]);
    }).pipe(Effect.provide(testLayer)),
  );
});
