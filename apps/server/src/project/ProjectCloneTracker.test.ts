import { describe, expect, it } from "@effect/vitest";
import { ProjectId, SourceControlRepositoryError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { parseGitCloneProgressLine } from "./gitCloneProgress.ts";

const projectId = ProjectId.make("project-1");
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "git@github.com:octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};

function makeHarness(options?: {
  readonly clone?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["cloneRepository"];
}) {
  const created: Array<{ projectId: ProjectId; workspaceRoot: string }> = [];
  const cloned: Array<ProjectId> = [];
  const discarded: Array<string> = [];
  const hooks: ProjectCloneTracker.ProjectCloneHooks = {
    createProject: (input) =>
      Effect.sync(() => {
        created.push({ projectId: input.projectId, workspaceRoot: input.workspaceRoot });
      }),
    onCloned: (input) => Effect.sync(() => void cloned.push(input.projectId)),
  };
  const layer = ProjectCloneTracker.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone: (input) =>
          Effect.succeed({
            destinationPath: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            cloneUrl: input.remoteUrl ?? "",
            repository: null,
          }),
        cloneRepository:
          options?.clone ??
          ((input) =>
            Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            })),
        discardClone: (destination) => Effect.sync(() => void discarded.push(destination)),
      }),
    ),
  );
  return { layer, hooks, created, cloned, discarded };
}

describe("ProjectCloneTracker", () => {
  it.effect("creates the project first and reports the clone through the stream", () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onProgress?.({ stage: "receiving", percent: 40, detail: "1 MiB" }) ??
              Effect.void
          );
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const collected = yield* tracker.stream.pipe(
        Stream.takeUntil((clones) => clones[0]?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const result = yield* tracker.start(startInput, harness.hooks);
      expect(result.cwd).toBe("/workspace/t3code");
      // The project exists before git runs so the draft can open immediately.
      expect(harness.created).toEqual([{ projectId, workspaceRoot: "/workspace/t3code" }]);

      yield* Effect.yieldNow;
      const running = yield* tracker.get(projectId);
      expect(running).toMatchObject({ phase: "running", stage: "receiving", percent: 40 });

      yield* Deferred.succeed(release, undefined);
      const lists = yield* Fiber.join(collected);
      const final = lists.at(-1)?.[0];
      expect(final).toMatchObject({ phase: "done", percent: 100 });
      expect(harness.cloned).toEqual([projectId]);

      // Done clones drop out after the grace window so the toast can settle.
      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed clone with git's own explanation and retries it", () => {
    let attempts = 0;
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              });
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(true);
      // The partial checkout is cleared so git sees an empty destination.
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(attempts).toBe(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cancel interrupts the clone and removes the partial checkout", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;

      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      // Nothing left to cancel; retry is what brings it back.
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a cancel that lands after git finished keeps the checkout", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness();
    // The clone itself completes instantly; the post-clone hook is what hangs.
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      onCloned: () => Deferred.await(gate),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("discard forgets a project's clone when the project is deleted", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      yield* tracker.discard(projectId);
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not create a project when the clone cannot be prepared", () => {
    const harness = makeHarness();
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: () =>
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: "unknown",
                detail: "Destination path already exists and is not empty.",
              }),
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, harness.hooks));
      expect(error.message).toContain("not empty");
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

describe("parseGitCloneProgressLine", () => {
  it("parses git's transfer counters and ignores other output", () => {
    expect(
      parseGitCloneProgressLine("Receiving objects:  45% (4500/10000), 12.30 MiB | 5.00 MiB/s"),
    ).toEqual({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" });
    expect(parseGitCloneProgressLine("Resolving deltas: 100% (700/700), done.")).toEqual({
      stage: "resolving",
      percent: 100,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Compressing objects:  12% (3/25)")).toEqual({
      stage: "counting",
      percent: 12,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Updating files:  78% (2104/2700)")).toEqual({
      stage: "checkout",
      percent: 78,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Enumerating objects: 10, done.")).toEqual({
      stage: "counting",
      percent: null,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Cloning into 't3code'...")).toBeNull();
    expect(parseGitCloneProgressLine("fatal: repository not found")).toBeNull();
  });
});
