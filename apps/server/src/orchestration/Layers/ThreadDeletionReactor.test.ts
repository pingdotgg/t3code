import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  GitManagerError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { runProcess } from "../../processRunner.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { WorkspaceOwnershipRepository } from "../../persistence/Services/WorkspaceOwnership.ts";
import { ProjectSetupScriptRunner } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  groupOpenPullRequestAssociationRefreshes,
  resolvePullRequestFromCwds,
  ThreadDeletionReactorLive,
  worktreeTrashDirectory,
} from "./ThreadDeletionReactor.ts";
import { findCanonicalActiveWorktreeOwner } from "../worktreeOwnership.ts";
import {
  logCleanupCauseUnlessInterrupted,
  processAfterWorktreeReservation,
  runAfterThreadRuntimeTeardown,
} from "./ThreadDeletionReactor.ts";

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    workflowRuns: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  worktreePath: string | null,
  deletedAt: string | null = null,
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    pendingRuntimeMode: null,
    interactionMode: "default",
    branch: null,
    worktreePath,
    reviewResult: null,
    latestTurn: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    archivedAt: null,
    deletedAt,
    messages: [],
    proposedPlans: [],
    queuedTurns: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

type FixtureThread = OrchestrationReadModel["threads"][number];

interface CleanupFixture {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly setupScriptRuns: Array<string>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly runGit: (cwd: string, args: ReadonlyArray<string>) => Promise<string>;
  readonly registeredWorktrees: () => Promise<string>;
  readonly jobStatus: () => Promise<string | undefined>;
  /** Starts the reactor (startup archive sweep) and waits for cleanup to settle. */
  readonly start: () => Promise<void>;
  /** Unarchives the thread through a domain event and waits for the reactor. */
  readonly unarchive: () => Promise<void>;
}

/**
 * Runs the production cleanup reactor against a disposable Git repository with
 * one archived chat that owns a `feature` worktree. Only orchestration, provider,
 * terminal, and PR-resolution boundaries are stubbed; Git and SQLite are real.
 */
async function withCleanupFixture(
  options: { readonly pullRequest: NonNullable<FixtureThread["pullRequest"]> | null },
  body: (fixture: CleanupFixture) => Promise<void>,
): Promise<void> {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "t3-cleanup-reactor-"));
  const repositoryRoot = path.join(fixtureRoot, "repo");
  const worktreePath = path.join(fixtureRoot, "feature");
  await mkdir(repositoryRoot);
  const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
    const result = await runProcess("git", args, {
      cwd,
      timeoutMs: 15_000,
      maxBufferBytes: 128 * 1024,
      allowNonZeroExit: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Cleanup Test",
        GIT_AUTHOR_EMAIL: "cleanup@example.test",
        GIT_COMMITTER_NAME: "Cleanup Test",
        GIT_COMMITTER_EMAIL: "cleanup@example.test",
      },
    });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };

  await runGit(repositoryRoot, ["init", "-b", "main"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "fixture\n");
  await runGit(repositoryRoot, ["add", "README.md"]);
  await runGit(repositoryRoot, ["commit", "-m", "fixture"]);
  await runGit(repositoryRoot, ["worktree", "add", "-b", "feature", worktreePath, "HEAD"]);

  const timestamp = new Date().toISOString();
  const project = {
    id: ProjectId.make("project-1"),
    title: "Cleanup fixture",
    workspaceRoot: repositoryRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  } satisfies OrchestrationReadModel["projects"][number];
  let thread: FixtureThread = {
    ...makeThread("thread-cleanup-fixture", worktreePath),
    projectId: project.id,
    branch: "feature",
    archivedAt: timestamp,
    pullRequest: options.pullRequest,
  };
  const readModel = () => ({ ...makeReadModel([thread]), projects: [project] });
  const resolvedPullRequest =
    options.pullRequest === null ? null : { ...options.pullRequest, state: "merged" as const };
  const setupScriptRuns: Array<string> = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const domainEvents = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.sync(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 1 };
      }),
    withWorktreeLock: (effect) => effect,
    streamDomainEvents: Stream.fromQueue(domainEvents),
    acquireDomainEventSubscription: Effect.die("unused in cleanup fixture"),
  });
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-cleanup-reactor-test-",
  });
  const runtime = ManagedRuntime.make(
    ThreadDeletionReactorLive.pipe(
      Layer.provide(engineLayer),
      Layer.provide(Layer.mock(ProviderService)({ stopSession: () => Effect.void })),
      Layer.provide(Layer.mock(TerminalManager)({ close: () => Effect.void })),
      Layer.provide(
        Layer.mock(WorkspaceOwnershipRepository)({
          getByThreadId: () => Effect.succeed([]),
          release: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager)({
          resolvePullRequest: () =>
            resolvedPullRequest === null
              ? Effect.die("archive cleanup must not require a pull request")
              : Effect.succeed({ pullRequest: resolvedPullRequest }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.sync(() => {
              setupScriptRuns.push(input.worktreePath);
              return { status: "no-script" as const };
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(GitStatusBroadcaster)({
          refreshStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: false,
              isDefaultBranch: false,
              branch: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              pr: null,
            }),
        }),
      ),
      Layer.provide(GitCoreLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(configLayer),
      Layer.provide(NodeServices.layer),
    ),
  );

  const scope = await runtime.runPromise(Scope.make("sequential"));
  try {
    const reactor = await runtime.runPromise(Effect.service(ThreadDeletionReactor));
    const jobs = await runtime.runPromise(Effect.service(WorktreeCleanupJobRepository));
    await body({
      repositoryRoot,
      worktreePath,
      setupScriptRuns,
      dispatched,
      runGit,
      registeredWorktrees: () => runGit(repositoryRoot, ["worktree", "list", "--porcelain"]),
      jobStatus: async () =>
        Option.getOrUndefined(await runtime.runPromise(jobs.getByThreadId(thread.id)))?.status,
      start: async () => {
        await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
        await runtime.runPromise(reactor.drain);
      },
      unarchive: async () => {
        const updatedAt = new Date().toISOString();
        thread = { ...thread, archivedAt: null, updatedAt };
        await Effect.runPromise(
          Queue.offer(domainEvents, {
            sequence: 2,
            eventId: EventId.make("event-unarchive"),
            type: "thread.unarchived",
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: updatedAt,
            commandId: CommandId.make("command-unarchive"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: { threadId: thread.id, updatedAt },
          } as OrchestrationEvent),
        );
        // Let the domain-event fiber hand the event to the worker before draining.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await runtime.runPromise(reactor.drain);
      },
    });
  } finally {
    await runtime.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    await runtime.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  describe("processAfterWorktreeReservation", () => {
    it("releases the ownership lock before slow cleanup work", async () => {
      let lockHeld = false;

      await Effect.runPromise(
        processAfterWorktreeReservation(
          (effect) =>
            Effect.sync(() => {
              lockHeld = true;
            }).pipe(
              Effect.andThen(effect),
              Effect.ensuring(
                Effect.sync(() => {
                  lockHeld = false;
                }),
              ),
            ),
          Effect.succeed(Option.some("reserved")),
          () =>
            Effect.sync(() => {
              expect(lockHeld).toBe(false);
            }),
        ),
      );
    });

    it("skips stale queued cleanup after unarchive before worker execution", async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const blockerStarted = yield* Deferred.make<void>();
            const releaseBlocker = yield* Deferred.make<void>();
            let archived = true;
            let stopSessionCalls = 0;
            let terminalCloseCalls = 0;
            let terminalHistoryDeletes = 0;
            let worktreeRemovalCalls = 0;

            const worker = yield* makeDrainableWorker<"block" | "cleanup", never, never>(
              (item): Effect.Effect<void, never, never> =>
                item === "block"
                  ? Deferred.succeed(blockerStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseBlocker)),
                    )
                  : processAfterWorktreeReservation(
                      (effect: Effect.Effect<Option.Option<string>, never, never>) => effect,
                      Effect.sync(() =>
                        archived ? Option.some("reserved") : Option.none<string>(),
                      ),
                      () =>
                        runAfterThreadRuntimeTeardown(
                          Effect.sync(() => {
                            stopSessionCalls += 1;
                          }),
                          Effect.sync(() => {
                            terminalCloseCalls += 1;
                            terminalHistoryDeletes += 1;
                          }),
                          Effect.sync(() => {
                            worktreeRemovalCalls += 1;
                          }),
                        ),
                    ),
            );

            yield* worker.enqueue("block");
            yield* worker.enqueue("cleanup");
            yield* Deferred.await(blockerStarted);

            archived = false;
            yield* Deferred.succeed(releaseBlocker, undefined);
            yield* worker.drain;

            expect(stopSessionCalls).toBe(0);
            expect(terminalCloseCalls).toBe(0);
            expect(terminalHistoryDeletes).toBe(0);
            expect(worktreeRemovalCalls).toBe(0);
          }),
        ),
      );
    });
  });

  describe("ThreadDeletionReactorLive", () => {
    it("groups the same PR identity across worktrees into one resolver lookup", () => {
      const timestamp = "2026-09-14T12:00:00.000Z";
      const project = {
        id: ProjectId.make("project-1"),
        title: "Refresh grouping",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      } satisfies OrchestrationReadModel["projects"][number];
      const pullRequest = {
        number: 42,
        title: "Shared PR",
        url: "https://github.com/acme/example/pull/42",
        baseBranch: "main",
        headBranch: "feature/shared",
        state: "open" as const,
      };
      const readModel = {
        ...makeReadModel([
          {
            ...makeThread("thread-refresh-a", "/tmp/worktree-a"),
            projectId: project.id,
            pullRequests: [{ pullRequest, source: "manual", linkedAt: timestamp }],
          },
          {
            ...makeThread("thread-refresh-b", "/tmp/worktree-b"),
            projectId: project.id,
            pullRequests: [{ pullRequest, source: "manual", linkedAt: timestamp }],
          },
        ]),
        projects: [project],
      };

      const groups = groupOpenPullRequestAssociationRefreshes(readModel);
      let resolveCalls = 0;
      for (const group of groups) {
        resolveCalls += 1;
        expect(group.pullRequest.url).toBe(pullRequest.url);
      }

      expect(resolveCalls).toBe(1);
      expect(groups[0]?.cwds).toEqual(["/tmp/worktree-a", "/tmp/project", "/tmp/worktree-b"]);
      expect(groups[0]?.candidates).toHaveLength(2);
    });

    it("falls back to another checkout when the first grouped refresh cwd fails", async () => {
      const calls: string[] = [];
      const pullRequest = {
        number: 42,
        title: "Shared PR",
        url: "https://github.com/acme/example/pull/42",
        baseBranch: "main",
        headBranch: "feature/shared",
        state: "open" as const,
      };

      const resolved = await Effect.runPromise(
        resolvePullRequestFromCwds(
          ["/tmp/unhealthy-worktree", "/tmp/healthy-worktree"],
          pullRequest.url,
          ({ cwd }) => {
            calls.push(cwd);
            return cwd === "/tmp/unhealthy-worktree"
              ? Effect.fail(
                  new GitManagerError({
                    operation: "test.resolvePullRequest",
                    detail: "checkout unavailable",
                  }),
                )
              : Effect.succeed({ pullRequest });
          },
        ),
      );

      expect(calls).toEqual(["/tmp/unhealthy-worktree", "/tmp/healthy-worktree"]);
      expect(resolved).toEqual({ pullRequest });
    });

    it("does not swallow resolver defects while trying fallback checkouts", async () => {
      const calls: string[] = [];
      const exit = await Effect.runPromiseExit(
        resolvePullRequestFromCwds(
          ["/tmp/defective-worktree", "/tmp/healthy-worktree"],
          "https://github.com/acme/example/pull/42",
          ({ cwd }) => {
            calls.push(cwd);
            return Effect.die("resolver defect");
          },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["/tmp/defective-worktree"]);
    });

    it("removes a clean archived merged-PR worktree from a disposable Git repository", async () => {
      await withCleanupFixture(
        {
          pullRequest: {
            number: 1,
            title: "Fixture",
            url: "https://github.com/example/repo/pull/1",
            baseBranch: "main",
            headBranch: "feature",
            state: "open",
          },
        },
        async (fixture) => {
          await fixture.start();

          expect(await fixture.jobStatus()).toBe("completed");
          expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);
        },
      );
    });

    it("removes a clean archived worktree without a pull request and keeps its branch commits", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        await writeFile(path.join(fixture.worktreePath, "work.txt"), "unmerged work\n");
        await fixture.runGit(fixture.worktreePath, ["add", "work.txt"]);
        await fixture.runGit(fixture.worktreePath, ["commit", "-m", "unmerged work"]);
        const featureHead = (
          await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])
        ).trim();

        await fixture.start();

        expect(await fixture.jobStatus()).toBe("completed");
        expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);
        expect(existsSync(fixture.worktreePath)).toBe(false);
        expect(await readdir(worktreeTrashDirectory(fixture.worktreePath))).toEqual([]);
        expect(
          (await fixture.runGit(fixture.repositoryRoot, ["rev-parse", "feature"])).trim(),
        ).toBe(featureHead);
      });
    });

    it("keeps an archived worktree with uncommitted work", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        const draftPath = path.join(fixture.worktreePath, "draft.txt");
        await writeFile(draftPath, "uncommitted\n");

        await fixture.start();

        expect(await fixture.jobStatus()).toBe("waiting");
        expect(await fixture.registeredWorktrees()).toContain(fixture.worktreePath);
        expect(await readFile(draftPath, "utf8")).toBe("uncommitted\n");
      });
    });

    it("restores a removed worktree on its branch and reruns setup when the chat is unarchived", async () => {
      await withCleanupFixture({ pullRequest: null }, async (fixture) => {
        await writeFile(path.join(fixture.worktreePath, "work.txt"), "unmerged work\n");
        await fixture.runGit(fixture.worktreePath, ["add", "work.txt"]);
        await fixture.runGit(fixture.worktreePath, ["commit", "-m", "unmerged work"]);

        await fixture.start();
        expect(await fixture.registeredWorktrees()).not.toContain(fixture.worktreePath);

        await fixture.unarchive();

        expect(await fixture.registeredWorktrees()).toContain(fixture.worktreePath);
        expect(
          (await fixture.runGit(fixture.worktreePath, ["branch", "--show-current"])).trim(),
        ).toBe("feature");
        expect(await readFile(path.join(fixture.worktreePath, "work.txt"), "utf8")).toBe(
          "unmerged work\n",
        );
        expect(fixture.setupScriptRuns).toEqual([fixture.worktreePath]);
        expect(fixture.dispatched).toEqual([]);
      });
    });
  });

  describe("runAfterThreadRuntimeTeardown", () => {
    it("runs cleanup only after both teardown operations settle successfully", async () => {
      const events: string[] = [];

      await Effect.runPromise(
        runAfterThreadRuntimeTeardown(
          Effect.sync(() => {
            events.push("provider");
          }),
          Effect.sync(() => {
            events.push("terminal");
          }),
          Effect.sync(() => {
            events.push("cleanup");
          }),
        ),
      );

      expect(events.slice(0, 2).toSorted()).toEqual(["provider", "terminal"]);
      expect(events.at(-1)).toBe("cleanup");
    });

    it("does not run cleanup when teardown fails but still settles the other teardown", async () => {
      let terminalClosed = false;
      let cleanupRan = false;

      const exit = await Effect.runPromiseExit(
        runAfterThreadRuntimeTeardown(
          Effect.fail("provider stop failed"),
          Effect.sync(() => {
            terminalClosed = true;
          }),
          Effect.sync(() => {
            cleanupRan = true;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminalClosed).toBe(true);
      expect(cleanupRan).toBe(false);
    });
  });

  describe("findCanonicalActiveWorktreeOwner", () => {
    const deletedThreadId = ThreadId.make("thread-deleted");
    const worktreePath = "/tmp/worktree";

    it("detects another active thread using a canonical path alias", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-active", "/tmp/parent/../worktree"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.some(ThreadId.make("thread-active")));
    });

    it("ignores deleted threads and different worktrees", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-old", worktreePath, "2026-07-30T00:00:02.000Z"),
        makeThread("thread-other", "/tmp/other"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.none());
    });

    it("ignores archived threads", async () => {
      const archivedOwner = {
        ...makeThread("thread-archived", worktreePath),
        archivedAt: "2026-07-30T00:00:02.000Z",
      };

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(
            makeReadModel([makeThread("thread-deleted", worktreePath), archivedOwner]),
            deletedThreadId,
            worktreePath,
          ),
        ),
      ).resolves.toEqual(Option.none());
    });
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
