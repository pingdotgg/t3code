import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import { make } from "./ThreadSettlementReactor.ts";

const projectId = ProjectId.make("project-1");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

function makeThread(input: {
  readonly id: string;
  readonly branch?: string | null;
  readonly cwd?: string;
  readonly pinned?: boolean;
}): OrchestrationThreadShell {
  const threadId = ThreadId.make(input.id);
  return {
    id: threadId,
    projectId,
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.cwd ?? null,
    latestTurn: {
      turnId: TurnId.make(`turn-${input.id}`),
      state: "completed",
      // @effect/vitest's test clock starts at the Unix epoch.
      requestedAt: "1960-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...(input.pinned ? { pinnedAt: "2020-01-02T00:00:00.000Z" } : {}),
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function vcsStatus(
  branch: string,
  state: "open" | "closed" | "merged" | null,
  headRef = branch,
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: branch,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr:
      state === null
        ? null
        : {
            number: 1,
            title: branch,
            url: `https://example.test/${branch}`,
            baseRef: "main",
            headRef,
            state,
          },
  };
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly peekStatus?: VcsStatusBroadcaster["Service"]["peekStatus"];
  readonly pollStatus?: VcsStatusBroadcaster["Service"]["pollStatus"];
  readonly opportunisticWork?: boolean;
}) {
  return Effect.gen(function* () {
    const snapshot = {
      snapshotSequence: 1,
      projects: [project],
      threads: input.threads,
      updatedAt: "2020-01-02T00:00:00.000Z",
    } satisfies OrchestrationShellSnapshot;
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const dependencies = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineShape),
      Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.succeed(snapshot),
      } as unknown as ProjectionSnapshotQueryShape),
      ServerSettingsService.layerTest(),
      Layer.succeed(VcsStatusBroadcaster, {
        getStatus: () => Effect.die("getStatus should not be called"),
        peekStatus: input.peekStatus ?? (() => Effect.succeed(null)),
        pollStatus: input.pollStatus ?? (() => Effect.die("pollStatus should not be called")),
        refreshLocalStatus: () => Effect.die("refreshLocalStatus should not be called"),
        refreshStatus: () => Effect.die("refreshStatus should not be called"),
        streamStatus: () => Stream.empty,
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunOpportunisticWork: Effect.succeed(input.opportunisticWork ?? false),
      }),
      NodeServices.layer,
    );
    const reactor = yield* make.pipe(Effect.provide(dependencies));
    return { reactor, dispatched };
  });
}

it.effect("persists inactivity and merged-PR settlement while leaving other pins alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inactivity = makeThread({ id: "inactivity" });
      const pinnedClosed = makeThread({
        id: "pinned-closed",
        branch: "feature/closed",
        cwd: "/repo/closed",
        pinned: true,
      });
      const pinnedOpen = makeThread({
        id: "pinned-open",
        branch: "feature/open",
        cwd: "/repo/open",
        pinned: true,
      });
      const pinnedMerged = makeThread({
        id: "pinned-merged",
        branch: "feature/merged",
        cwd: "/repo/merged",
        pinned: true,
      });
      const byCwd = new Map([
        [pinnedClosed.worktreePath, vcsStatus(pinnedClosed.branch!, "closed")],
        [pinnedOpen.worktreePath, vcsStatus(pinnedOpen.branch!, "open")],
        [pinnedMerged.worktreePath, vcsStatus(pinnedMerged.branch!, "merged")],
      ]);
      const { reactor, dispatched } = yield* makeHarness({
        threads: [inactivity, pinnedClosed, pinnedOpen, pinnedMerged],
        peekStatus: ({ cwd }) => Effect.succeed(byCwd.get(cwd) ?? null),
        pollStatus: (cwd) => Effect.succeed(byCwd.get(cwd)!),
        opportunisticWork: true,
      });

      yield* reactor.start();
      yield* reactor.drain;

      const settledThreadIds = (yield* Ref.get(dispatched))
        .filter((command) => command.type === "thread.settle")
        .map((command) => command.threadId)
        .sort();
      expect(settledThreadIds).toEqual([inactivity.id, pinnedMerged.id].sort());
    }),
  ),
);

it.effect("re-verifies cached PR state and settles a pin only after merge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = makeThread({
        id: "pinned-merged-after-cache",
        branch: "feature/merge-later",
        cwd: "/repo/merge-later",
        pinned: true,
      });
      const pollCalls = yield* Ref.make(0);
      const { reactor, dispatched } = yield* makeHarness({
        threads: [thread],
        peekStatus: () => Effect.succeed(vcsStatus(thread.branch!, "open")),
        pollStatus: () =>
          Ref.update(pollCalls, (count) => count + 1).pipe(
            Effect.as(vcsStatus(thread.branch!, "merged")),
          ),
        opportunisticWork: true,
      });

      yield* reactor.start();
      yield* reactor.drain;

      expect(yield* Ref.get(pollCalls)).toBe(1);
      expect(
        (yield* Ref.get(dispatched)).map((command) =>
          command.type === "thread.settle" ? command.threadId : null,
        ),
      ).toEqual([thread.id]);
    }),
  ),
);

it.effect("does not settle when PR verification fails or belongs to another branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lookupFailed = makeThread({
        id: "lookup-failed",
        branch: "feature/open-pr",
        cwd: "/repo/lookup-failed",
      });
      const mismatchedMerge = makeThread({
        id: "mismatched-merge",
        branch: "feature/current",
        cwd: "/repo/mismatched",
        pinned: true,
      });
      const { reactor, dispatched } = yield* makeHarness({
        threads: [lookupFailed, mismatchedMerge],
        peekStatus: ({ cwd }) =>
          Effect.succeed(
            cwd === mismatchedMerge.worktreePath
              ? vcsStatus(mismatchedMerge.branch!, "merged", "feature/other")
              : null,
          ),
        pollStatus: (cwd) =>
          cwd === lookupFailed.worktreePath
            ? Effect.fail(
                new GitManagerError({
                  operation: "ThreadSettlementReactor.test",
                  cwd,
                  detail: "temporary lookup failure",
                }),
              )
            : Effect.succeed(vcsStatus(mismatchedMerge.branch!, "merged", "feature/other")),
        opportunisticWork: true,
      });

      yield* reactor.start();
      yield* reactor.drain;

      expect(yield* Ref.get(dispatched)).toEqual([]);
    }),
  ),
);

it.effect("bounds live verification and lets cooldown-skipped entries yield the next batch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = Array.from({ length: 7 }, (_, index) =>
        makeThread({
          id: `pinned-${index}`,
          branch: `feature/${index}`,
          cwd: `/repo/${index}`,
          pinned: true,
        }),
      );
      const branchByCwd = new Map(threads.map((thread) => [thread.worktreePath, thread.branch!]));
      const polledCwds = yield* Ref.make<ReadonlyArray<string>>([]);
      const { reactor, dispatched } = yield* makeHarness({
        threads,
        pollStatus: (cwd) =>
          Ref.update(polledCwds, (values) => [...values, cwd]).pipe(
            Effect.as(vcsStatus(branchByCwd.get(cwd)!, "open")),
          ),
        opportunisticWork: true,
      });

      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(polledCwds)).toHaveLength(5);

      yield* reactor.start();
      yield* reactor.drain;
      expect(new Set(yield* Ref.get(polledCwds))).toEqual(new Set(branchByCwd.keys()));
      expect(yield* Ref.get(dispatched)).toEqual([]);
    }),
  ),
);
