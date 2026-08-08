// @effect-diagnostics globalDate:off -- fixtures are offsets from the real clock the sweep reads.
import {
  ProjectId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { make, ThreadAutoSettleReactor } from "./ThreadAutoSettleReactor.ts";

const NOW_MS = Date.now();
const STALE = new Date(NOW_MS - 4 * 24 * 60 * 60 * 1_000).toISOString();
const FRESH = new Date(NOW_MS - 60 * 60 * 1_000).toISOString();

function makeProject(): OrchestrationProjectShell {
  return {
    id: ProjectId.make("project-1"),
    title: "Project",
    workspaceRoot: "/workspace/project-1",
    defaultModelSelection: null,
    scripts: [],
    createdAt: STALE,
    updatedAt: STALE,
  };
}

function makeThread(input: {
  readonly id: string;
  readonly activityAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly branch?: string | null;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("project-1"),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: null,
    latestTurn: null,
    createdAt: STALE,
    updatedAt: STALE,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: input.activityAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0];
  /** Cached VCS status handed to peekStatus; null = nothing cached. */
  readonly peekStatus?: VcsStatusBroadcaster["Service"]["peekStatus"];
  /** Live refreshStatus result; unset = the sweep must not go live. */
  readonly refreshStatus?: VcsStatusBroadcaster["Service"]["refreshStatus"];
  /** Whether the background policy allows live PR lookups. Default false. */
  readonly opportunisticWork?: boolean;
  /** Make getSettings fail, exercising the disabled-sweep fallback. */
  readonly failSettings?: boolean;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [makeProject()],
    threads: input.threads,
    updatedAt: STALE,
  };
  const layer = Layer.effect(ThreadAutoSettleReactor, make()).pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.provide(
      Layer.succeed(VcsStatusBroadcaster, {
        getStatus: () => Effect.die("getStatus should not be called"),
        peekStatus: input.peekStatus ?? (() => Effect.succeed(null)),
        refreshLocalStatus: () => Effect.die("refreshLocalStatus should not be called"),
        refreshStatus:
          input.refreshStatus ?? (() => Effect.die("refreshStatus should not be called")),
        streamStatus: () => Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunOpportunisticWork: Effect.succeed(input.opportunisticWork ?? false),
      }),
    ),
    Layer.provide(
      input.failSettings === true
        ? Layer.mock(ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({
                operation: "read-file",
                settingsPath: "/tmp/settings.json",
                cause: "unreadable",
              }),
            ),
          })
        : ServerSettingsService.layerTest(input.settingsOverrides ?? {}),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { dispatched, layer };
}

const runSweep = (layer: Layer.Layer<ThreadAutoSettleReactor, ServerSettingsError>) =>
  Effect.service(ThreadAutoSettleReactor).pipe(
    Effect.flatMap((reactor) => reactor.sweepOnce),
    Effect.provide(layer),
    Effect.orDie,
  );

describe("ThreadAutoSettleReactor", () => {
  // it.live: fixtures are offsets from the real clock the sweep reads; the
  // TestClock's epoch-zero "now" would put every fixture in the future.
  it.live("settles quiet threads past the window", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = makeHarness({
        threads: [
          makeThread({ id: "stale", activityAt: STALE }),
          makeThread({ id: "fresh", activityAt: FRESH }),
          makeThread({ id: "pinned-active", activityAt: STALE, settledOverride: "active" }),
          makeThread({ id: "already-settled", activityAt: STALE, settledOverride: "settled" }),
        ],
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0];
      expect(command?.type).toBe("thread.settle");
      if (command?.type === "thread.settle") {
        expect(command.threadId).toBe("stale");
        expect(command.commandId.startsWith("server:auto-settle:")).toBe(true);
      }
    }),
  );

  it.live("does nothing with auto-settle disabled", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale", activityAt: STALE })],
        settingsOverrides: { threadAutoSettleAfterDays: null },
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );

  it.live("defers a quiet branch-carrying thread with no cached PR state", () =>
    Effect.gen(function* () {
      // peekStatus returns null (nothing cached) and opportunistic work is
      // off, so the sweep can neither confirm nor rule out an open PR — it
      // must leave the thread alone rather than hide work waiting on review.
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale-branch", activityAt: STALE, branch: "feature/x" })],
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );

  it.live("re-verifies a stale cached open PR and settles once it turns out merged", () =>
    Effect.gen(function* () {
      // The cache still says "open" (polling stopped before the merge). The
      // sweep must not trust it: cached open triggers a live verification,
      // which reports merged, and the thread settles.
      const vcsStatus = (state: "open" | "merged") => ({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/x",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: {
          number: 42,
          title: "Feature X",
          url: "https://github.com/example/repo/pull/42",
          baseRef: "main",
          headRef: "feature/x",
          state,
        },
      });
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale-open", activityAt: STALE, branch: "feature/x" })],
        peekStatus: () => Effect.succeed(vcsStatus("open")),
        refreshStatus: () => Effect.succeed(vcsStatus("merged")),
        opportunisticWork: true,
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.type).toBe("thread.settle");
    }),
  );

  it.live("keeps a quiet thread active when live verification confirms the PR is open", () =>
    Effect.gen(function* () {
      const vcsStatus = {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/x",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: {
          number: 42,
          title: "Feature X",
          url: "https://github.com/example/repo/pull/42",
          baseRef: "main",
          headRef: "feature/x",
          state: "open" as const,
        },
      };
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale-open", activityAt: STALE, branch: "feature/x" })],
        peekStatus: () => Effect.succeed(vcsStatus),
        refreshStatus: () => Effect.succeed(vcsStatus),
        opportunisticWork: true,
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );

  it.live("does not trust a cached no-PR result: live verification finds the open PR", () =>
    Effect.gen(function* () {
      // The cached status predates the PR being opened (pr: null). The sweep
      // must live-verify rather than settle on the stale cache; the live
      // lookup finds an open PR and the thread stays active.
      const vcsStatus = (pr: null | "open") => ({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/x",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr:
          pr === null
            ? null
            : {
                number: 42,
                title: "Feature X",
                url: "https://github.com/example/repo/pull/42",
                baseRef: "main",
                headRef: "feature/x",
                state: pr,
              },
      });
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "cached-no-pr", activityAt: STALE, branch: "feature/x" })],
        peekStatus: () => Effect.succeed(vcsStatus(null)),
        refreshStatus: () => Effect.succeed(vcsStatus("open")),
        opportunisticWork: true,
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );

  it.live("disables the inactivity sweep when the settings read fails", () =>
    Effect.gen(function* () {
      // A failed settings read must not fall back to the default window: the
      // user may have auto-settle disabled, and hiding threads on a read
      // error is not undone by the next successful sweep.
      const { dispatched, layer } = makeHarness({
        threads: [makeThread({ id: "stale", activityAt: STALE })],
        failSettings: true,
      });
      yield* runSweep(layer);

      expect(dispatched).toHaveLength(0);
    }),
  );
});
