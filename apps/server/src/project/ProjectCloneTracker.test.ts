import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationDispatchCommandError,
  ProjectId,
  projectCloneProgressSummary,
  type SourceControlCloneProtocol,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { ProjectConflictError } from "./ProjectService.ts";
import { parseGitCloneProgressLine } from "./gitCloneProgress.ts";

const projectId = ProjectId.make("project-1");
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "git@github.com:octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};

function clonePersistence() {
  let bytes: Uint8Array | undefined;
  return Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.sync(() => Option.fromUndefinedOr(bytes)),
      set: (_name, value) =>
        Effect.sync(() => {
          bytes = value;
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      findActiveByWorkspaceRoot: () => Effect.succeedSome({ projectId } as ProjectStore.ProjectRow),
    }),
  );
}

/** Secret storage whose reads and writes a test can break and inspect by name. */
function faultyPersistence(options: {
  readonly journal?: Uint8Array;
  readonly failRead?: boolean;
}) {
  const stored = new Map<string, Uint8Array>();
  if (options.journal) stored.set("pending-project-clones", options.journal);
  const control = { failWrites: false, failLookup: false, writes: 0, stored };
  const persistence = Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) =>
        options.failRead
          ? Effect.fail(
              new ServerSecretStore.SecretStoreReadError({
                resource: name,
                cause: new Error("EIO"),
              }),
            )
          : Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
      set: (name, value) =>
        Effect.suspend(() => {
          control.writes += 1;
          if (control.failWrites) {
            return Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: new Error("ENOSPC"),
              }),
            );
          }
          stored.set(name, value);
          return Effect.void;
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      findActiveByWorkspaceRoot: (workspaceRoot) =>
        control.failLookup
          ? Effect.fail(
              new ProjectStore.ProjectStoreV2Error({
                operation: "findActiveByWorkspaceRoot",
                cause: new Error("SQLITE_BUSY"),
              }),
            )
          : Effect.succeedSome({
              projectId:
                workspaceRoot === startInput.destinationPath
                  ? projectId
                  : ProjectId.make("project-2"),
            } as ProjectStore.ProjectRow),
    }),
  );
  return { persistence, control };
}

function makeHarness(options?: {
  readonly clone?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["cloneRepository"];
  readonly prepare?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["prepareClone"];
  readonly persistence?: ReturnType<typeof clonePersistence>;
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
    Layer.provide(options?.persistence ?? clonePersistence()),
    Layer.provide(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone:
          options?.prepare ??
          ((input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              cloneUrl: input.remoteUrl ?? "",
              repository: null,
            })),
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

const awaitPhase = (
  tracker: ProjectCloneTracker.ProjectCloneTracker["Service"],
  id: ProjectId,
  phase: "done" | "failed",
) =>
  tracker.stream.pipe(
    Stream.filter((clones) =>
      clones.some((clone) => clone.projectId === id && clone.phase === phase),
    ),
    Stream.runHead,
  );

describe("ProjectCloneTracker", () => {
  it.effect(
    "blocks thread creation and offers retry after an interrupted clone is restored",
    () => {
      let attempts = 0;
      const cloning = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        persistence: clonePersistence(),
        clone: (input) =>
          Effect.suspend(() => {
            attempts += 1;
            if (attempts === 1)
              return Deferred.succeed(cloning, undefined).pipe(Effect.andThen(Effect.never));
            return Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            });
          }),
      });
      const { layer } = harness;
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
          yield* tracker.start(startInput, harness.hooks);
          yield* Deferred.await(cloning);
        }).pipe(Effect.provide(layer));

        yield* Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
          expect(yield* tracker.get(projectId)).toMatchObject({
            phase: "failed",
            error: expect.stringContaining("restart"),
          });
          const rejected = yield* Effect.flip(
            ProjectCloneTracker.rejectCommandsDuringClone(tracker, {
              type: "thread.create",
              projectId,
            }),
          );
          expect(rejected.message).toContain("Retry the clone first");
          const completed = yield* tracker.stream.pipe(
            Stream.filter((clones) => clones.some((clone) => clone.phase === "done")),
            Stream.runHead,
            Effect.forkChild,
          );
          expect(yield* tracker.retry(projectId, harness.hooks.onCloned)).toBe(true);
          expect(Option.isSome(yield* Fiber.join(completed))).toBe(true);
          expect(harness.discarded).toEqual([]);
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect.each([
    { name: "finishes a clone whose checkout completed", leftovers: false },
    { name: "keeps files it cannot prove complete and asks to inspect them", leftovers: true },
  ])("a retry after a restart $name", ({ leftovers }) => {
    let attempts = 0;
    let restarted = false;
    const cloning = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: () =>
        Effect.suspend(() => {
          attempts += 1;
          return Deferred.succeed(cloning, undefined).pipe(Effect.andThen(Effect.never));
        }),
      prepare: (input, options) =>
        Effect.suspend(() => {
          if (
            restarted &&
            (options?.reuseCheckout !== true || options.requireCompleteCheckout !== true)
          )
            return Effect.die("A restored retry must reuse only a complete checkout");
          if (restarted && leftovers)
            return Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: SourceControlProviderKind.make("unknown"),
                detail: "Destination path already exists and is not empty.",
              }),
            );
          return Effect.succeed({
            destinationPath: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            cloneUrl: input.remoteUrl ?? "",
            repository: null,
            ...(restarted ? { existingCheckout: true as const } : {}),
          });
        }),
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        yield* tracker.start(startInput, harness.hooks);
        yield* Deferred.await(cloning);
      }).pipe(Effect.provide(harness.layer));
      restarted = true;

      yield* Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        const hookRan = yield* Deferred.make<void>();
        const onCloned: ProjectCloneTracker.ProjectCloneHooks["onCloned"] = (input) =>
          harness.hooks.onCloned(input).pipe(Effect.andThen(Deferred.succeed(hookRan, undefined)));
        if (leftovers) {
          const refused = yield* Effect.flip(tracker.retry(projectId, onCloned));
          expect(refused.detail).toContain("Inspect or move the folder, then retry.");
          expect(refused.detail).not.toContain("Remove");
          expect(yield* tracker.get(projectId)).toMatchObject({ phase: "failed" });
        } else {
          expect(yield* tracker.retry(projectId, onCloned)).toBe(true);
          expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done" });
          yield* Deferred.await(hookRan);
          expect(harness.cloned).toEqual([projectId]);
        }
        // Nothing is deleted, and the clone isn't started again.
        expect(harness.discarded).toEqual([]);
        expect(attempts).toBe(1);
      }).pipe(Effect.provide(harness.layer));
    });
  });

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
      expect(harness.created).toEqual([{ projectId, workspaceRoot: "/workspace/t3code" }]);

      yield* Effect.yieldNow;
      const running = yield* tracker.get(projectId);
      expect(running).toMatchObject({ phase: "running", stage: "receiving", percent: 40 });

      yield* Deferred.succeed(release, undefined);
      const lists = yield* Fiber.join(collected);
      const final = lists.at(-1)?.[0];
      expect(final).toMatchObject({ phase: "done", percent: 100 });
      expect(harness.cloned).toEqual([projectId]);

      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("flags a clone stalled when git goes quiet and clears it when git speaks", () => {
    const release = Deferred.makeUnsafe<void>();
    const resumed = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          const report = options?.onProgress ?? (() => Effect.void);
          yield* report({ stage: "receiving", percent: 24, detail: "168.80 MiB | 20.69 MiB/s" });
          yield* Deferred.await(resumed);
          yield* report({ stage: "receiving", percent: 25, detail: "170.00 MiB | 1.00 MiB/s" });
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);

      yield* TestClock.adjust("19 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);
      yield* TestClock.adjust("1 second");
      const stalled = yield* tracker.get(projectId);
      expect(stalled).toMatchObject({ stalled: true, percent: 24 });
      expect(projectCloneProgressSummary(stalled!)).toBe("Receiving objects · 24% · Stalled");

      yield* Deferred.succeed(resumed, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ stalled: false, percent: 25 });

      yield* TestClock.adjust("20 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done", stalled: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed clone with git's own explanation and retries it", () => {
    const protocols: Array<SourceControlCloneProtocol | undefined> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() => {
          protocols.push(input.protocol);
          return protocols.length === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
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
      yield* tracker.start({ ...startInput, protocol: "ssh" }, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(true);
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(protocols).toEqual(["ssh", "ssh"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clamps a long failure without splitting a surrogate pair", () => {
    const harness = makeHarness({
      clone: () =>
        Effect.fail(
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: `${"e".repeat(998)}\u{1F680}tail`,
          }),
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.error).toBe(`${"e".repeat(998)}…`);
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
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a cancel that lands after git finished keeps the checkout", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness();
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

  it.effect("hands git the credential-bearing URL while snapshots carry the redacted one", () => {
    const cloneUrls: Array<string> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.sync(() => {
          cloneUrls.push(input.remoteUrl ?? "");
          return { cwd: input.destinationPath, remoteUrl: "", repository: null };
        }),
    });
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(clonePersistence()),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: (input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: "https://github.com/octocat/t3code.git",
              cloneUrl: "https://user:s3cret@github.com/octocat/t3code.git",
              repository: null,
            }),
          cloneRepository: (input) =>
            Effect.sync(() => {
              cloneUrls.push(input.remoteUrl ?? "");
              return { cwd: input.destinationPath, remoteUrl: "", repository: null };
            }),
          discardClone: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect(result.remoteUrl).toBe("https://github.com/octocat/t3code.git");
      expect(cloneUrls).toEqual(["https://user:s3cret@github.com/octocat/t3code.git"]);
    }).pipe(Effect.provide(layer));
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

  it.effect("releases the claim when project creation fails", () => {
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: () =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "workspace root exists" })),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, hooks));
      expect(error.message).toContain("workspace root exists");
      expect(yield* tracker.get(projectId)).toBeNull();
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clones for the project that already owns the empty destination", () => {
    const owner = ProjectId.make("project-stranded");
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: (input) =>
        Effect.fail(
          new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            conflictingProjectId: owner,
          }),
        ),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, hooks);
      expect(result.projectId).toBe(owner);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(owner)).toMatchObject({
        projectId: owner,
        destinationPath: "/workspace/t3code",
        phase: "done",
      });
      expect(harness.cloned).toEqual([owner]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a fresh clone into a failed clone's destination supersedes it", () => {
    let attempts = 0;
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              }),
        ),
    });
    // The failed clone's project still owns the destination.
    const conflictingHooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: (input) =>
        Effect.fail(
          new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            conflictingProjectId: projectId,
          }),
        ),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* awaitPhase(tracker, projectId, "failed");

      const second = ProjectId.make("project-2");
      const result = yield* tracker.start({ ...startInput, projectId: second }, conflictingHooks);
      expect(result.projectId).toBe(projectId);
      yield* awaitPhase(tracker, projectId, "done");
      expect(yield* tracker.get(second)).toBeNull();
      expect(harness.cloned).toEqual([projectId]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a start whose journal write fails keeps the failed clone it would replace", () => {
    const { persistence, control } = faultyPersistence({});
    let attempts = 0;
    const harness = makeHarness({
      persistence,
      clone: () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.never,
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* awaitPhase(tracker, projectId, "failed");

      control.failWrites = true;
      const second = ProjectId.make("project-2");
      yield* Effect.flip(tracker.start({ ...startInput, projectId: second }, harness.hooks));
      expect(yield* tracker.get(second)).toBeNull();
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "failed",
        error: "fatal: repository not found",
      });

      control.failWrites = false;
      expect(yield* tracker.retry(projectId, harness.hooks.onCloned)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("an undecodable clone journal is set aside instead of stopping the server", () => {
    const garbage = new TextEncoder().encode("{not json");
    const { persistence, control } = faultyPersistence({ journal: garbage });
    const harness = makeHarness({ persistence });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(control.stored.get("pending-project-clones-unreadable")).toEqual(garbage);
      yield* tracker.start(startInput, harness.hooks);
      expect(Option.isSome(yield* awaitPhase(tracker, projectId, "done"))).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a pending clone whose project lookup fails is kept for the next restart", () => {
    const { persistence, control } = faultyPersistence({});
    const harness = makeHarness({ persistence, clone: () => Effect.never });
    const second = ProjectId.make("project-2");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        yield* tracker.start(startInput, harness.hooks);
      }).pipe(Effect.provide(harness.layer));

      control.failLookup = true;
      yield* Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        expect(yield* tracker.get(projectId)).toBeNull();
        control.failLookup = false;
        // This journal write must carry the entry it could not restore.
        yield* tracker.start(
          { ...startInput, projectId: second, destinationPath: "/workspace/other" },
          harness.hooks,
        );
      }).pipe(Effect.provide(harness.layer));

      yield* Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        expect(yield* tracker.get(projectId)).toMatchObject({
          phase: "failed",
          error: expect.stringContaining("restart"),
        });
      }).pipe(Effect.provide(harness.layer));
    });
  });

  it.effect("a retry keeps files a refused clone found in its destination", () => {
    let attempts = 0;
    const harness = makeHarness({
      clone: () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: SourceControlRepositoryService.DESTINATION_NOT_EMPTY,
                }),
              )
            : Effect.never,
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* awaitPhase(tracker, projectId, "failed");
      expect(yield* tracker.retry(projectId, harness.hooks.onCloned)).toBe(true);
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a discard keeps files a clone refuses while it is being interrupted", () => {
    const started = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: () =>
        Effect.uninterruptible(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(
              Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: SourceControlRepositoryService.DESTINATION_NOT_EMPTY,
                }),
              ),
            ),
          ),
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Deferred.await(started);
      // Runs until it waits on the clone's interrupt, before the clone refuses.
      const discarding = yield* tracker
        .discard(projectId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(discarding);
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("an unreadable clone journal is never overwritten", () => {
    const { persistence, control } = faultyPersistence({ failRead: true });
    const harness = makeHarness({ persistence });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      expect(yield* tracker.get(projectId)).toBeNull();
      const refused = yield* Effect.flip(tracker.start(startInput, harness.hooks));
      expect(refused.message).toContain("could not be saved");
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(control.writes).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses a second clone into a destination that is still cloning", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      const error = yield* Effect.flip(
        tracker.start({ ...startInput, projectId: ProjectId.make("project-2") }, harness.hooks),
      );
      expect(error.message).toContain("already in progress");
      expect((yield* tracker.get(projectId))?.phase).toBe("running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not create a project when the clone cannot be prepared", () => {
    const harness = makeHarness();
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(clonePersistence()),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: () =>
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: SourceControlProviderKind.make("unknown"),
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
    expect(
      parseGitCloneProgressLine("Receiving objects: 100% (5/5), 40.00 MiB | 1.40 MiB/s, done."),
    ).toEqual({ stage: "receiving", percent: 100, detail: "40.00 MiB | 1.40 MiB/s" });
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
    expect(
      parseGitCloneProgressLine("Filtering content:  66% (2/3), 11.92 MiB | 1009.00 KiB/s"),
    ).toEqual({ stage: "checkout", percent: 66, detail: "11.92 MiB | 1009.00 KiB/s" });
    expect(parseGitCloneProgressLine("remote: Enumerating objects: 10, done.")).toEqual({
      stage: "counting",
      percent: null,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Cloning into 't3code'...")).toBeNull();
    expect(parseGitCloneProgressLine("fatal: repository not found")).toBeNull();
  });
});
