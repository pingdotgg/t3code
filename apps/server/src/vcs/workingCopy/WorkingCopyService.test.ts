import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { WorkingCopyCwdDeniedError } from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import type * as VcsProcess from "../VcsProcess.ts";
import * as WorkingCopy from "./WorkingCopyService.ts";
import { WorkingCopyService } from "./WorkingCopyService.ts";

const TEST_EPOCH = "2024-01-01T00:00:00.000Z";

const okOutput: VcsProcess.VcsProcessOutput = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

interface Workspace {
  readonly projectRoots: ReadonlyArray<string>;
  readonly worktreePaths: ReadonlyArray<string>;
}

const projectionsLayer = (workspace: Workspace) =>
  Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        updatedAt: TEST_EPOCH,
        projects: workspace.projectRoots.map((workspaceRoot, index) => ({
          id: `project-${index}`,
          title: `project-${index}`,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: TEST_EPOCH,
          updatedAt: TEST_EPOCH,
        })),
        threads: workspace.worktreePaths.map((worktreePath, index) => ({
          id: `thread-${index}`,
          worktreePath,
        })),
      } as never),
  });

/**
 * A registry that answers with a fixed repository root and a recorded
 * executor. Nothing here spawns git: the assertions are about the guard and
 * the scheduler, not about git's behaviour.
 */
const registryLayer = (options: {
  readonly repositoryRoot: (cwd: string) => string;
  readonly execute?: (input: {
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, never>;
}) =>
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    resolve: (input) =>
      Effect.succeed({
        kind: "git" as const,
        repository: {
          kind: "git" as const,
          rootPath: options.repositoryRoot(input.cwd),
          metadataPath: null,
          freshness: { source: "live-local", observedAt: TEST_EPOCH, expiresAt: undefined },
        },
        driver: {
          execute: options.execute ?? (() => Effect.succeed(okOutput)),
        },
      } as never),
  });

const makeLayer = (
  workspace: Workspace,
  registry: Layer.Layer<VcsDriverRegistry.VcsDriverRegistry>,
) =>
  WorkingCopy.layer.pipe(
    Layer.provide(registry),
    Layer.provide(projectionsLayer(workspace)),
    Layer.provideMerge(NodeServices.layer),
  );

const identityRoot = (cwd: string) => cwd;

it.effect("denies a cwd outside every project root and thread worktree", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/tmp/somewhere-else" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    assert.strictEqual(failure.cwd, "/tmp/somewhere-else");
    assert.strictEqual(failure.operation, "workingCopy.status");
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies a sibling directory whose name merely prefixes an allowed root", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj-evil" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies everything when the workspace has no projects and no worktrees", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: [], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("denies a mutation on a denied cwd before any git runs", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const failure = yield* service
      .stagePaths({ cwd: "/tmp/elsewhere", paths: ["a.ts"] })
      .pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    // Denial happens before the driver is ever asked to run anything.
    assert.deepStrictEqual(calls, []);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({
          repositoryRoot: identityRoot,
          execute: (input) =>
            Effect.sync(() => {
              calls.push(input.args);
              return okOutput;
            }),
        }),
      ),
    ),
  );
});

it.effect("denies when the cwd is allowed but git resolves it to a repository root outside", () =>
  Effect.gen(function* () {
    // A project checked out *inside* a larger repository: without the second
    // guard the panel would operate on the outer repository's worktree.
    const service = yield* WorkingCopyService;

    const failure = yield* service.status({ cwd: "/work/proj/nested" }).pipe(Effect.flip);

    assert.instanceOf(failure, WorkingCopyCwdDeniedError);
    assert.strictEqual(failure.cwd, "/work");
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: () => "/work" }),
      ),
    ),
  ),
);

it.effect("allows a thread worktree that is not itself a project root", () =>
  Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    // Reaching git at all is the assertion: the guard let it through.
    const status = yield* service.status({ cwd: "/work/worktrees/thread-a" });

    assert.strictEqual(status.isRepo, true);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: ["/work/worktrees/thread-a"] },
        registryLayer({ repositoryRoot: identityRoot }),
      ),
    ),
  ),
);

it.effect("serializes mutations per repository — the second waits for the first", () => {
  const order: Array<string> = [];
  let started = 0;
  let signalFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const execute = () =>
    Effect.gen(function* () {
      started += 1;
      const label = started === 1 ? "first" : "second";
      order.push(`${label}:start`);
      if (label === "first") {
        signalFirstStarted();
        yield* Effect.promise(() => firstReleased);
      }
      order.push(`${label}:end`);
      return okOutput;
    });

  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const first = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj", paths: ["a.ts"] }),
    );
    yield* Effect.promise(() => firstStarted);

    const second = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj", paths: ["b.ts"] }),
    );
    // Give the second fiber every chance to run. What stops it is the
    // per-repository semaphore, not the scheduler.
    for (let tick = 0; tick < 50; tick += 1) {
      yield* Effect.yieldNow;
    }
    assert.deepStrictEqual(order, ["first:start"]);

    yield* Effect.sync(() => releaseFirst());
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    assert.deepStrictEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot, execute }),
      ),
    ),
  );
});

it.effect("does not serialize across different repositories", () => {
  const order: Array<string> = [];
  let started = 0;
  let signalFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const execute = () =>
    Effect.gen(function* () {
      started += 1;
      const label = started === 1 ? "first" : "second";
      order.push(`${label}:start`);
      if (label === "first") {
        signalFirstStarted();
        yield* Effect.promise(() => firstReleased);
      }
      order.push(`${label}:end`);
      return okOutput;
    });

  return Effect.gen(function* () {
    const service = yield* WorkingCopyService;

    const first = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj-a", paths: ["a.ts"] }),
    );
    yield* Effect.promise(() => firstStarted);

    const second = yield* Effect.forkChild(
      service.stagePaths({ cwd: "/work/proj-b", paths: ["b.ts"] }),
    );
    yield* Fiber.join(second);

    // A busy repository must not block an idle one.
    assert.deepStrictEqual(order, ["first:start", "second:start", "second:end"]);

    yield* Effect.sync(() => releaseFirst());
    yield* Fiber.join(first);
  }).pipe(
    Effect.provide(
      makeLayer(
        { projectRoots: ["/work/proj-a", "/work/proj-b"], worktreePaths: [] },
        registryLayer({ repositoryRoot: identityRoot, execute }),
      ),
    ),
  );
});
