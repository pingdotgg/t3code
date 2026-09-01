import {
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectionThreadRepository,
  type ProjectionThread,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import * as ThreadSettleCleanupReactorModule from "./ThreadSettleCleanupReactor.ts";

describe("isWorktreeSharedWithAnotherThread", () => {
  const target = {
    threadId: ThreadId.make("thread-settle-cleanup-target"),
    worktreePath: "/tmp/worktrees/repo/branch",
  };
  const otherId = ThreadId.make("thread-settle-cleanup-other");

  it("is false when no other thread uses the worktree", () => {
    const threads = [
      { ...target, deletedAt: null },
      { threadId: otherId, worktreePath: "/tmp/worktrees/repo/other", deletedAt: null },
      { threadId: otherId, worktreePath: null, deletedAt: null },
    ];

    expect(
      ThreadSettleCleanupReactorModule.isWorktreeSharedWithAnotherThread(threads, target),
    ).toBe(false);
  });

  it("is true when a live thread shares the worktree", () => {
    const threads = [
      { ...target, deletedAt: null },
      { threadId: otherId, worktreePath: target.worktreePath, deletedAt: null },
    ];

    expect(
      ThreadSettleCleanupReactorModule.isWorktreeSharedWithAnotherThread(threads, target),
    ).toBe(true);
  });

  it("ignores deleted threads sharing the worktree", () => {
    const threads = [
      { ...target, deletedAt: null },
      { threadId: otherId, worktreePath: target.worktreePath, deletedAt: "2026-08-30T00:00:00Z" },
    ];

    expect(
      ThreadSettleCleanupReactorModule.isWorktreeSharedWithAnotherThread(threads, target),
    ).toBe(false);
  });

  it("is false when the target has no worktree", () => {
    expect(
      ThreadSettleCleanupReactorModule.isWorktreeSharedWithAnotherThread([], {
        threadId: target.threadId,
        worktreePath: null,
      }),
    ).toBe(false);
  });
});

describe("ThreadSettleCleanupReactor cleanup gates", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-settle-cleanup-reactor");
  const projectId = ProjectId.make("project-settle-cleanup-reactor");

  const settledEvent: OrchestrationEvent = {
    sequence: 1,
    eventId: EventId.make("evt-settled-1"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.settled",
    occurredAt: now,
    commandId: CommandId.make("cmd-settled-1"),
    causationEventId: null,
    correlationId: CorrelationId.make("cmd-settled-1"),
    metadata: {},
    payload: { threadId, settledAt: now, updatedAt: now },
  };

  const threadRow = (overrides: Partial<ProjectionThread>): ProjectionThread =>
    ({
      threadId,
      projectId,
      worktreePath: null,
      deletedAt: null,
      settledOverride: "settled",
      ...overrides,
    }) as unknown as ProjectionThread;

  const runGit = Effect.fn("runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    yield* vcsProcess.run({
      operation: "ThreadSettleCleanupReactor.test.runGit",
      command: "git",
      args,
      cwd,
    });
  });

  // A real repository ignoring node_modules; "linked" hands back an actual
  // `git worktree add` checkout, "primary" the repo checkout itself.
  const makeWorktreeFixture = (kind: "linked" | "primary") =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-settle-reactor-repo-",
      });
      yield* runGit(repo, ["init", "--initial-branch=main"]);
      yield* runGit(repo, ["config", "user.email", "test@example.com"]);
      yield* runGit(repo, ["config", "user.name", "Test User"]);
      yield* fileSystem.writeFileString(path.join(repo, ".gitignore"), "node_modules/\n");
      yield* runGit(repo, ["add", "."]);
      yield* runGit(repo, ["commit", "-m", "init"]);
      let worktree = repo;
      if (kind === "linked") {
        const worktreeParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-settle-reactor-wt-",
        });
        worktree = path.join(worktreeParent, "worktree");
        yield* runGit(repo, ["worktree", "add", worktree, "-b", "settle-cleanup-test"]);
      }
      yield* fileSystem.makeDirectory(path.join(worktree, "node_modules/pkg"), {
        recursive: true,
      });
      return worktree;
    });

  const runSettleCleanup = (input: {
    readonly enabled: boolean;
    readonly fixtureKind: "linked" | "primary";
    readonly rowOverrides?: Partial<ProjectionThread>;
    readonly siblingRows?: (worktree: string) => ReadonlyArray<ProjectionThread>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = yield* makeWorktreeFixture(input.fixtureKind);
        const row = threadRow({ worktreePath: worktree, ...input.rowOverrides });
        const rows = [row, ...(input.siblingRows?.(worktree) ?? [])];

        const engine = {
          streamDomainEvents: Stream.make(settledEvent),
        } as unknown as OrchestrationEngineShape;
        const repository = {
          getById: () => Effect.succeed(Option.some(row)),
          listByProjectId: () => Effect.succeed(rows),
        } as unknown as ProjectionThreadRepositoryShape;
        const layer = ThreadSettleCleanupReactorModule.layer.pipe(
          Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
          Layer.provide(Layer.succeed(ProjectionThreadRepository, repository)),
          Layer.provide(
            ServerSettings.layerTest({ cleanWorktreeArtifactsOnSettle: input.enabled }),
          ),
          Layer.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettleCleanupReactorModule.ThreadSettleCleanupReactor;
          yield* reactor.start();
          yield* reactor.drainThrough(settledEvent.sequence);
        }).pipe(Effect.provide(layer), Effect.scoped);

        return yield* fileSystem.exists(path.join(worktree, "node_modules"));
      }),
    ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))));

  effectIt.effect("cleans artifacts when enabled and every guard passes", () =>
    Effect.gen(function* () {
      expect(yield* runSettleCleanup({ enabled: true, fixtureKind: "linked" })).toBe(false);
    }),
  );

  effectIt.effect("skips when the setting is disabled", () =>
    Effect.gen(function* () {
      expect(yield* runSettleCleanup({ enabled: false, fixtureKind: "linked" })).toBe(true);
    }),
  );

  effectIt.effect("skips when the thread no longer reads settled", () =>
    Effect.gen(function* () {
      expect(
        yield* runSettleCleanup({
          enabled: true,
          fixtureKind: "linked",
          rowOverrides: { settledOverride: null },
        }),
      ).toBe(true);
    }),
  );

  effectIt.effect("skips a deleted thread", () =>
    Effect.gen(function* () {
      expect(
        yield* runSettleCleanup({
          enabled: true,
          fixtureKind: "linked",
          rowOverrides: { deletedAt: now },
        }),
      ).toBe(true);
    }),
  );

  effectIt.effect("skips when another live thread shares the worktree", () =>
    Effect.gen(function* () {
      expect(
        yield* runSettleCleanup({
          enabled: true,
          fixtureKind: "linked",
          siblingRows: (worktree) => [
            threadRow({
              threadId: ThreadId.make("thread-settle-cleanup-sibling"),
              worktreePath: worktree,
            }),
          ],
        }),
      ).toBe(true);
    }),
  );

  effectIt.effect("skips a primary checkout", () =>
    Effect.gen(function* () {
      expect(yield* runSettleCleanup({ enabled: true, fixtureKind: "primary" })).toBe(true);
    }),
  );
});
