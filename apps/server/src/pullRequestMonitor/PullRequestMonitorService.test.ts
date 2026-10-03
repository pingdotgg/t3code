import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceExchangeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PullRequestMonitorError,
  PullRequestOperationError,
  ThreadId,
  type ModelSelection,
  type PullRequestMonitorFeedbackDeliveryId,
  type PullRequestMonitorSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Fiber from "effect/Fiber";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import MigrationMonitors from "../persistence/Migrations/071_PullRequestMonitors.ts";
import MigrationFeedback from "../persistence/Migrations/072_PullRequestMonitorFeedback.ts";
import MigrationOwnership from "../persistence/Migrations/073_PullRequestMonitorOwnership.ts";
import MigrationFallback from "../persistence/Migrations/074_PullRequestMonitorFallback.ts";
import MigrationRevisionIdentity from "../persistence/Migrations/076_PullRequestMonitorRevisionIdentity.ts";
import MigrationReviewDisputes from "../persistence/Migrations/098_PullRequestMonitorReviewDisputes.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  layer as pullRequestMonitorFeedbackServiceLayer,
  PullRequestMonitorFeedbackService,
} from "./PullRequestMonitorFeedbackService.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import {
  associatedOwnerCandidates,
  layer as pullRequestMonitorServiceLayer,
  PullRequestMonitorService,
} from "./PullRequestMonitorService.ts";
import { emptyCursor } from "./monitorDiff.ts";
import { LEASE_TTL_MS, POLL_BATCH_LIMIT } from "./pollSchedule.ts";
import { emptyFeedbackReadiness } from "./readiness.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";
import { handoffToSubmitInput } from "./PullRequestReviewHandoffReactor.ts";

const projectId = ProjectId.make("proj_monitor_1");

/** Same clock the monitor writes with, so lease fixtures line up with commit time. */
const isoNow = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

function sampleSnapshot(
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    state: "open",
    isDraft: false,
    headSha: "deadbeef",
    baseBranch: "main",
    headBranch: "feat/monitor",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Monitor me",
    url: "https://github.com/acme/app/pull/42",
    fetchedAt: "2026-08-11T00:00:00.000Z",
    sourceRevision: "rev-1",
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
      baseComparisonKnown: true,
    },
    requiredCheckCoverage: {
      expected: [],
      observed: [],
      completeness: "complete",
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
    ...overrides,
  };
}

let pullRequestDetailCalls = 0;

const fakePullRequests = PullRequestService.PullRequestService.of({
  list: () => Effect.die("unused"),
  listStats: () => Effect.die("unused"),
  detail: (input) =>
    Effect.succeed({
      provider: "github" as const,
      capabilities: {
        diff: true,
        comment: true,
        actions: ["merge", "ready", "draft", "close", "reopen"] as const,
        mergeMethods: ["merge", "squash", "rebase"] as const,
        search: true,
        review: {
          inlineComment: true,
          reply: true,
          resolve: true,
          verdicts: ["comment", "approve", "request-changes"] as const,
        },
        reviewers: { request: true, listCandidates: true },
      },
      viewerPermissions: {
        actions: ["merge", "ready", "draft", "close", "reopen"] as const,
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"] as const,
        requestReviewers: true,
      },
      projectId: input.projectId,
      projectTitle: "App",
      workspaceRoot: "/tmp/app",
      repository: input.repository,
      number: input.number,
      title: "Monitor me",
      body: "",
      url: `https://github.com/${input.repository}/pull/${input.number}`,
      author: null,
      state: "open" as const,
      isDraft: false,
      mergeability: "mergeable" as const,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      headBranch: "feat/monitor",
      baseBranch: "main",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          pullRequestDetailCalls += 1;
        }),
      ),
    ),
  activity: () => Effect.die("unused"),
  diff: () => Effect.die("unused"),
  runAction: () => Effect.die("unused"),
  comment: () => Effect.die("unused"),
  submitReview: () => Effect.die("unused"),
  replyToThread: () => Effect.die("unused"),
  setThreadResolution: () => Effect.die("unused"),
  reviewerCandidates: () => Effect.die("unused"),
  requestReviewers: () => Effect.die("unused"),
  invalidate: () => Effect.void,
  monitorSnapshot: () =>
    Effect.gen(function* () {
      monitorSnapshotCalls += 1;
      const snapshot = currentSnapshot;
      // Runs while the poll attempt is in flight: the seam where a slow provider read
      // can outlive the attempt's lease.
      yield* monitorSnapshotHook;
      return snapshot;
    }),
});

/** Fresh provider state the monitor re-reads before every delivery. */
let currentSnapshot: PullRequestMonitorSnapshot = sampleSnapshot();
/** Injected mid-read behaviour; tests reset it to `Effect.void` after one use. */
let monitorSnapshotHook: Effect.Effect<void, PullRequestOperationError> = Effect.void;
let monitorSnapshotCalls = 0;

const knownThreads = new Map<
  string,
  {
    projectId: typeof projectId;
    worktreePath: string | null;
    archivedAt: string | null;
    busy: boolean;
    copilotSession?: boolean;
    instanceId?: string;
    pullRequest: { number: number; url: string } | null;
  }
>();

function seedThread(
  threadId: ThreadId,
  worktreePath: string | null = "/tmp/wt",
  pullRequest: { number: number; url: string } | null = null,
) {
  knownThreads.set(threadId, {
    projectId,
    worktreePath,
    archivedAt: null,
    busy: false,
    pullRequest,
  });
}

const abandonedThreadIds: ThreadId[] = [];
const dispatchedCommands: Array<{ type: string; threadId?: ThreadId }> = [];
const queuedMessages: string[] = [];
const launchedFallbackIds: ThreadId[] = [];
const preparedPrReferences: string[] = [];
let preparePrWorktreePath: string | null = "/tmp/pr-head";
let launchWorktreePath: string | null = "/tmp/fallback";

const fakeProjections = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.sync(() => {
      const row = knownThreads.get(threadId);
      if (!row) return Option.none();
      return Option.some({
        id: threadId,
        projectId: row.projectId,
        worktreePath: row.worktreePath,
        archivedAt: row.archivedAt,
        modelSelection: { instanceId: row.instanceId ?? "copilot", model: "gpt-test" },
        latestTurn: row.busy ? { state: "running" } : null,
        session:
          row.busy || row.copilotSession
            ? {
                status: row.busy ? "running" : "ready",
                activeTurnId: row.busy ? "turn-1" : null,
                providerName: "copilot",
                providerInstanceId: ProviderInstanceId.make("copilot"),
              }
            : null,
        hasPendingQueuedTurn: false,
      } as never);
    }),
  getProjectShellById: (id: typeof projectId) =>
    Effect.succeed(
      id === projectId
        ? Option.some({
            id: projectId,
            title: "App",
            workspaceRoot: "/tmp/app",
          } as never)
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"];

const fakeEngine = {
  getReadModel: () =>
    Effect.succeed({
      threads: [...knownThreads.entries()].map(([id, thread]) => ({
        id,
        projectId: thread.projectId,
        title: `Chat ${id}`,
        pullRequest: thread.pullRequest,
        archivedAt: thread.archivedAt,
        deletedAt: null,
      })),
    } as never),
  dispatch: (command: {
    type: string;
    threadId?: ThreadId;
    worktreePath?: string | null;
    bootstrap?: unknown;
    message?: { text: string };
  }) =>
    Effect.sync(() => {
      const entry: { type: string; threadId?: ThreadId } = { type: command.type };
      if (command.threadId !== undefined) entry.threadId = command.threadId;
      dispatchedCommands.push(entry);
      if (command.type === "thread.queued-turn.create" && command.message) {
        queuedMessages.push(command.message.text);
      }
      if (command.type === "thread.archive" && command.threadId) {
        abandonedThreadIds.push(command.threadId);
      }
      if (command.type === "thread.turn.interrupt" && command.threadId) {
        const row = knownThreads.get(command.threadId);
        if (row) knownThreads.set(command.threadId, { ...row, busy: false });
      }
      // Fallback creates the thread first, claims ownership, then starts a turn.
      if (command.type === "thread.create" && command.threadId) {
        const path =
          launchWorktreePath === null
            ? null
            : (command.worktreePath ?? `${launchWorktreePath}-${command.threadId}`);
        launchedFallbackIds.push(command.threadId);
        seedThread(command.threadId, path);
      }
      return { sequence: 1 };
    }),
} as unknown as OrchestrationEngineService["Service"];

const fakeGit = {
  preparePullRequestThread: (input: { reference: string }) =>
    Effect.gen(function* () {
      preparedPrReferences.push(input.reference);
      if (preparePrWorktreePath === null) {
        return yield* Effect.fail(new Error("PR head missing") as never);
      }
      return {
        pullRequest: {
          number: Number(String(input.reference).replace("#", "")),
          title: "Monitor me",
          url: "https://github.com/acme/app/pull/42",
          baseBranch: "main",
          headBranch: "feat/monitor",
          state: "open" as const,
        },
        branch: "feat/monitor",
        worktreePath: preparePrWorktreePath,
      } as never;
    }),
} as unknown as GitManager["Service"];

const defaultSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  autoMonitorPullRequestsOnCreate: true,
  autoLaunchPrMonitorFallback: true,
  textGenerationModelSelection: {
    instanceId: "openai",
    model: "gpt-test",
  } as ModelSelection,
};
let currentSettings = defaultSettings;

const SettingsLayer = Layer.effect(
  ServerSettingsService,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServerSettings>();
    return ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.sync(() => currentSettings),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          currentSettings = applyServerSettingsPatch(currentSettings, patch);
          yield* PubSub.publish(changes, currentSettings);
          return currentSettings;
        }),
      streamChanges: Stream.fromPubSub(changes),
    });
  }),
);

const MigratedSql = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
    yield* MigrationMonitors;
    yield* MigrationFeedback;
    yield* MigrationOwnership;
    yield* MigrationFallback;
    yield* MigrationRevisionIdentity;
    yield* MigrationReviewDisputes;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const FeedbackLayer = pullRequestMonitorFeedbackServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
);

// provideMerge engine/projections so method bodies that yield* them at call
// time still resolve (Layer.provide alone only satisfies construction R).
const TestLayer = pullRequestMonitorServiceLayer.pipe(
  Layer.provide(Layer.succeed(PullRequestService.PullRequestService, fakePullRequests)),
  Layer.provideMerge(FeedbackLayer),
  Layer.provide(Layer.succeed(GitManager, fakeGit)),
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, fakeProjections)),
  Layer.provideMerge(Layer.succeed(OrchestrationEngineService, fakeEngine)),
  Layer.provideMerge(MigratedSql),
  Layer.provideMerge(NodeCrypto.layer),
);

const layer = it.layer(TestLayer);

it("returns only active chats associated with the monitored pull request", () => {
  const candidates = associatedOwnerCandidates(
    [
      {
        id: ThreadId.make("owner"),
        projectId,
        title: "Fix PR",
        pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: ThreadId.make("other-pr"),
        projectId,
        title: "Other PR",
        pullRequest: { number: 43, url: "https://github.com/acme/app/pull/43" },
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: ThreadId.make("active-manual-link"),
        projectId,
        title: "Manual PR link",
        pullRequest: null,
        pullRequests: [
          {
            pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
          },
        ],
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: ThreadId.make("archived"),
        projectId,
        title: "Archived",
        pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
        archivedAt: "2026-08-17T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    { projectId, repository: "acme/app", number: 42 },
  );

  assert.deepStrictEqual(candidates, [
    { threadId: ThreadId.make("owner"), title: "Fix PR" },
    { threadId: ThreadId.make("active-manual-link"), title: "Manual PR link" },
  ]);
});

layer("PullRequestMonitorService", (it) => {
  it.effect("starts one canonical monitor and exposes status", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
      });
      assert.strictEqual(started.monitor.enabled, true);
      assert.strictEqual(started.monitor.repository, "acme/app");
      assert.strictEqual(started.monitor.number, 42);
      assert.isTrue(started.monitor.status === "monitoring" || started.monitor.status === "ready");

      const again = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
      });
      assert.strictEqual(again.monitor.id, started.monitor.id);

      const status = yield* service.status({ monitorId: started.monitor.id });
      assert.isNotNull(status.monitor);
      assert.isNotNull(status.latestSnapshot);
      assert.deepStrictEqual(status.ownerCandidates, []);
      assert.isArray(status.openFeedback);
      assert.isArray(status.recentDeliveries);
      assert.isArray(status.recentReports);

      const stopped = yield* service.stop({ monitorId: started.monitor.id });
      assert.strictEqual(stopped.monitor.enabled, false);
      assert.strictEqual(stopped.monitor.status, "stopped");
    }),
  );

  it.effect("bounds each background sweep to the global poll budget", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;

      for (let number = 100; number < 100 + POLL_BATCH_LIMIT + 2; number += 1) {
        yield* service.start({
          projectId,
          repository: "acme/app",
          number,
        });
      }

      yield* sql`
        UPDATE pull_request_monitors
        SET next_poll_at = '1970-01-01T00:00:00.000Z'
        WHERE enabled = 1
      `.pipe(Effect.orDie);

      const before = monitorSnapshotCalls;
      yield* service.pollOnce;
      assert.strictEqual(monitorSnapshotCalls - before, POLL_BATCH_LIMIT);
    }),
  );

  it.effect("transfers ownership to a single owner thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const ownerA = ThreadId.make("thr_owner_a");
      const ownerB = ThreadId.make("thr_owner_b");
      seedThread(ownerA);
      seedThread(ownerB);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 43,
        ownerThreadId: ownerA,
      });
      assert.strictEqual(started.monitor.ownerThreadId, ownerA);

      const transferred = yield* service.transferOwnership({
        monitorId: started.monitor.id,
        toThreadId: ownerB,
        reason: "fallback",
      });
      assert.strictEqual(transferred.monitor.ownerThreadId, ownerB);
      assert.isNull(transferred.monitor.linkedReviewThreadId);
    }),
  );

  it.effect("requires browser-selected owners to be actively associated with the PR", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const associated = ThreadId.make("associated-owner");
      const unrelated = ThreadId.make("unrelated-owner");
      const archived = ThreadId.make("archived-owner");
      seedThread(associated, "/tmp/associated", {
        number: 1044,
        url: "https://github.com/acme/app/pull/1044",
      });
      seedThread(unrelated, "/tmp/unrelated", {
        number: 45,
        url: "https://github.com/acme/app/pull/45",
      });
      seedThread(archived, "/tmp/archived", {
        number: 1044,
        url: "https://github.com/acme/app/pull/1044",
      });
      const archivedRow = knownThreads.get(archived)!;
      knownThreads.set(archived, {
        ...archivedRow,
        archivedAt: "2026-08-17T00:00:00.000Z",
      });

      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1044,
        ownerThreadId: associated,
        requireAssociatedOwner: true,
      });
      assert.strictEqual(started.monitor.ownerThreadId, associated);

      const unrelatedResult = yield* Effect.result(
        service.start({
          projectId,
          repository: "acme/app",
          number: 1044,
          ownerThreadId: unrelated,
          requireAssociatedOwner: true,
        }),
      );
      assert.strictEqual(unrelatedResult._tag, "Failure");

      const archivedResult = yield* Effect.result(
        service.start({
          projectId,
          repository: "acme/app",
          number: 1044,
          ownerThreadId: archived,
          requireAssociatedOwner: true,
        }),
      );
      assert.strictEqual(archivedResult._tag, "Failure");
    }),
  );

  it.effect("can explicitly resume a monitor in observe-only mode", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("owner-observe");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
        ownerThreadId: owner,
      });
      yield* service.stop({ monitorId: started.monitor.id });

      const resumed = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 42,
        ownerMode: "observe-only",
      });

      assert.isNull(resumed.monitor.ownerThreadId);
      assert.strictEqual(resumed.monitor.enabled, true);
    }),
  );

  it.effect("does not automatically re-enable a terminal monitor", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("terminal-monitor-owner");
      seedThread(owner, "/tmp/terminal-monitor", {
        number: 1045,
        url: "https://github.com/acme/app/pull/1045",
      });
      const originalSnapshot = currentSnapshot;
      currentSnapshot = sampleSnapshot({
        number: 1045,
        state: "closed",
      });

      const terminal = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1045,
        ownerThreadId: owner,
      });
      assert.strictEqual(terminal.monitor.status, "terminal");
      assert.isFalse(terminal.monitor.enabled);
      assert.strictEqual(
        yield* service.automationDeliveryState({
          reference: { projectId, repository: "acme/app", number: 1045 },
          threadId: owner,
        }),
        "terminal",
      );

      const detailCallsBeforeEnsure = pullRequestDetailCalls;
      const snapshotCallsBeforeEnsure = monitorSnapshotCalls;
      const ensured = yield* service.start({
        projectId,
        repository: " ACME/app ",
        number: 1045,
        ownerThreadId: owner,
        requireAssociatedOwner: true,
      });

      assert.strictEqual(ensured.monitor.status, "terminal");
      assert.isFalse(ensured.monitor.enabled);
      assert.strictEqual(pullRequestDetailCalls, detailCallsBeforeEnsure);
      assert.strictEqual(monitorSnapshotCalls, snapshotCallsBeforeEnsure);
      currentSnapshot = originalSnapshot;
    }),
  );

  it.effect("preserves an existing owner when started with an inherited fallback", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const explicitOwner = ThreadId.make("owner-explicit");
      const inheritedOwner = ThreadId.make("owner-inherited");
      seedThread(explicitOwner);
      seedThread(inheritedOwner);
      yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1045,
        ownerThreadId: explicitOwner,
      });

      const preserved = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1045,
        ownerThreadId: inheritedOwner,
        ownerMode: "preserve",
      });

      assert.strictEqual(preserved.monitor.ownerThreadId, explicitOwner);
    }),
  );

  it.effect("atomically claims an ownerless monitor with an inherited fallback", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const inheritedOwner = ThreadId.make("owner-inherited-claim");
      seedThread(inheritedOwner);
      yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1046,
        ownerMode: "observe-only",
      });

      const claimed = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1046,
        ownerThreadId: inheritedOwner,
        ownerMode: "preserve",
      });

      assert.strictEqual(claimed.monitor.ownerThreadId, inheritedOwner);
    }),
  );

  it.effect("rejects an invalid inherited fallback before claiming an ownerless monitor", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const missingOwner = ThreadId.make("owner-inherited-missing");
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1049,
        ownerMode: "observe-only",
      });

      const result = yield* Effect.result(
        service.start({
          projectId,
          repository: "acme/app",
          number: 1049,
          ownerThreadId: missingOwner,
          ownerMode: "preserve",
        }),
      );
      const status = yield* service.status({ monitorId: started.monitor.id });

      assert.strictEqual(result._tag, "Failure");
      assert.isNull(status.monitor?.ownerThreadId);
    }),
  );

  it.effect("retains a concurrent explicit transfer over an inherited claim", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const inheritedOwner = ThreadId.make("owner-inherited-race");
      const explicitOwner = ThreadId.make("owner-explicit-race");
      seedThread(inheritedOwner);
      seedThread(explicitOwner);
      yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1047,
        ownerMode: "observe-only",
      });
      yield* sql`
        CREATE TRIGGER preserve_owner_race
        AFTER UPDATE OF enabled ON pull_request_monitors
        WHEN NEW.number = 1047 AND NEW.owner_thread_id IS NULL
        BEGIN
          UPDATE pull_request_monitors
          SET owner_thread_id = 'owner-explicit-race'
          WHERE monitor_id = NEW.monitor_id;
        END
      `;

      const preserved = yield* service
        .start({
          projectId,
          repository: "acme/app",
          number: 1047,
          ownerThreadId: inheritedOwner,
          ownerMode: "preserve",
        })
        .pipe(Effect.ensuring(sql`DROP TRIGGER preserve_owner_race`.pipe(Effect.orDie)));

      assert.strictEqual(preserved.monitor.ownerThreadId, explicitOwner);
    }),
  );

  it.effect("does not mutate ownership when the existing monitor lookup fails", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const explicitOwner = ThreadId.make("owner-before-read-failure");
      const inheritedOwner = ThreadId.make("owner-after-read-failure");
      seedThread(explicitOwner);
      seedThread(inheritedOwner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 1048,
        ownerThreadId: explicitOwner,
      });
      yield* sql`
        UPDATE pull_request_monitors
        SET readiness_json = '{'
        WHERE monitor_id = ${started.monitor.id}
      `;

      const result = yield* Effect.result(
        service.start({
          projectId,
          repository: "acme/app",
          number: 1048,
          ownerThreadId: inheritedOwner,
          ownerMode: "preserve",
        }),
      );
      const rows = yield* sql<{ owner_thread_id: string | null }>`
        SELECT owner_thread_id
        FROM pull_request_monitors
        WHERE monitor_id = ${started.monitor.id}
      `;
      yield* sql`
        UPDATE pull_request_monitors
        SET readiness_json = NULL
        WHERE monitor_id = ${started.monitor.id}
      `;

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(rows[0]?.owner_thread_id, explicitOwner);
    }),
  );

  it.effect("submitFindings links review thread without dual owners", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const owner = ThreadId.make("thr_owner_main");
      const review = ThreadId.make("thr_review_1");
      seedThread(owner);
      seedThread(review);
      const result = yield* service.submitFindings({
        reference: {
          projectId,
          repository: "acme/app",
          number: 44,
        },
        reviewThreadId: review,
        ownerThreadId: owner,
        summary: "Three findings handed off",
        startMonitoring: true,
      });
      assert.strictEqual(result.monitoringStarted, true);
      assert.strictEqual(result.ownerThreadId, owner);
      assert.strictEqual(result.linkedReviewThreadId, review);
      assert.strictEqual(result.monitor.ownerThreadId, owner);
      assert.strictEqual(result.monitor.linkedReviewThreadId, review);
      assert.notStrictEqual(result.monitor.ownerThreadId, result.monitor.linkedReviewThreadId);

      const events = yield* sql<{
        readonly from_thread_id: string | null;
        readonly to_thread_id: string | null;
      }>`
        SELECT from_thread_id, to_thread_id
        FROM pull_request_monitor_ownership_events
        WHERE monitor_id = ${result.monitor.id}
      `;
      assert.deepEqual(events, [{ from_thread_id: null, to_thread_id: owner }]);
    }),
  );

  it.effect("submitFindings audits an owner handoff after starting an existing monitor", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const ownerA = ThreadId.make("thr_owner_audit_a");
      const ownerB = ThreadId.make("thr_owner_audit_b");
      const review = ThreadId.make("thr_review_audit");
      seedThread(ownerA);
      seedThread(ownerB);
      seedThread(review);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 45,
        ownerThreadId: ownerA,
      });

      const result = yield* service.submitFindings({
        reference: {
          projectId,
          repository: "acme/app",
          number: 45,
        },
        reviewThreadId: review,
        ownerThreadId: ownerB,
      });
      assert.strictEqual(result.monitor.ownerThreadId, ownerB);

      const events = yield* sql<{
        readonly from_thread_id: string | null;
        readonly to_thread_id: string | null;
      }>`
        SELECT from_thread_id, to_thread_id
        FROM pull_request_monitor_ownership_events
        WHERE monitor_id = ${started.monitor.id}
        ORDER BY created_at
      `;
      assert.deepEqual(events, [{ from_thread_id: ownerA, to_thread_id: ownerB }]);
    }),
  );

  it.effect("rejects ownership transfer to a missing project thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_owner_valid");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 46,
        ownerThreadId: owner,
      });

      const result = yield* Effect.result(
        service.transferOwnership({
          monitorId: started.monitor.id,
          toThreadId: ThreadId.make("thr_owner_missing"),
        }),
      );
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("launchFallback creates exclusive owner via prepared worktree thread", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 47,
      });
      assert.isNull(started.monitor.ownerThreadId);

      const before = launchedFallbackIds.length;
      const refsBefore = preparedPrReferences.length;
      const fallback = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isTrue(fallback.launched);
      assert.isNotNull(fallback.fallbackThreadId);
      assert.strictEqual(fallback.monitor.ownerThreadId, fallback.fallbackThreadId);
      assert.isNull(fallback.previousOwnerThreadId);
      assert.strictEqual(preparedPrReferences[refsBefore], "#47");
      assert.isTrue(launchedFallbackIds.length > before);

      // Second launch within cooldown should not dual-own while owner remains available.
      const again = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isFalse(again.launched);
      assert.strictEqual(again.skippedReason, "recent-fallback-cooldown");
      assert.strictEqual(again.fallbackThreadId, fallback.fallbackThreadId);
    }),
  );

  for (const [index, scenario] of [
    { name: "Copilot default-off", driver: "copilot", optIn: false, launch: false },
    {
      name: "explicit opt-in",
      driver: "copilot",
      optIn: true,
      launch: true,
    },
    { name: "other provider", driver: "codex", optIn: false, launch: true },
  ].entries()) {
    it.effect(`automatic fallback respects ${scenario.name}`, () =>
      Effect.gen(function* () {
        const service = yield* PullRequestMonitorService;
        const store = yield* PullRequestMonitorStore.make;
        const instanceId = ProviderInstanceId.make("fallback-provider");
        currentSettings = {
          ...defaultSettings,
          textGenerationModelSelection: { instanceId, model: "gpt-test" },
          copilotAutomaticPrFeedback: { [instanceId]: scenario.optIn },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make(scenario.driver),
              displayName: "Fallback provider",
              enabled: true,
            },
          },
        };
        currentSnapshot = sampleSnapshot({
          checkRuns: [
            {
              id: "fallback-check",
              name: "ci",
              status: "failure",
              headSha: "deadbeef",
              url: null,
              description: null,
            },
          ],
        });
        const before = dispatchedCommands.length;
        const refsBefore = preparedPrReferences.length;
        const started = yield* service.start({
          projectId,
          repository: "acme/app",
          number: 300 + index,
        });
        const launch = yield* store.latestFallbackLaunch(started.monitor.id);
        assert.strictEqual(launch?.status, scenario.launch ? "launched" : undefined);
        const commands = dispatchedCommands.slice(before);
        if (scenario.launch) {
          assert.isTrue(commands.some((command) => command.type === "thread.turn.start"));
          assert.strictEqual(preparedPrReferences.length, refsBefore + 1);
        } else {
          assert.deepStrictEqual(commands, []);
          assert.strictEqual(preparedPrReferences.length, refsBefore);
          assert.isNull(launch);
          const status = yield* service.status({ monitorId: started.monitor.id });
          assert.isNull(status.monitor?.ownerThreadId);
          assert.isAbove(status.openFeedback.length, 0);
          assert.include(status.automationBlockReason ?? "", "Automatic PR feedback is pending");
          assert.isNull(status.monitor?.lastError);

          // Explicit operator requests remain possible without enabling automation.
          const explicit = yield* service.launchFallback({ monitorId: started.monitor.id });
          assert.isTrue(explicit.launched);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            currentSettings = defaultSettings;
            currentSnapshot = sampleSnapshot();
          }),
        ),
      ),
    );
  }

  for (const busy of [false, true]) {
    it.effect(
      `blocks a Codex fallback from taking over an unavailable Copilot owner (busy=${busy})`,
      () =>
        Effect.gen(function* () {
          const service = yield* PullRequestMonitorService;
          const store = yield* PullRequestMonitorStore.make;
          const owner = ThreadId.make(`copilot-fallback-owner-${busy}`);
          const number = busy ? 341 : 340;
          seedThread(owner);
          const started = yield* service.start({
            projectId,
            repository: "acme/app",
            number,
            ownerThreadId: owner,
          });
          const row = knownThreads.get(owner)!;
          knownThreads.set(owner, {
            ...row,
            archivedAt: "1970-01-01T00:00:00.000Z",
            busy,
            copilotSession: true,
          });
          currentSettings = {
            ...defaultSettings,
            providerInstances: {},
            textGenerationModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-test",
            },
          };
          currentSnapshot = sampleSnapshot({
            checkRuns: [
              {
                id: "busy-owner-check",
                name: "ci",
                status: "failure",
                headSha: "deadbeef",
                url: null,
                description: null,
              },
            ],
          });
          const before = dispatchedCommands.length;
          const refsBefore = preparedPrReferences.length;
          yield* service.start({ projectId, repository: "acme/app", number });
          assert.deepStrictEqual(dispatchedCommands.slice(before), []);
          assert.strictEqual(preparedPrReferences.length, refsBefore);
          assert.strictEqual(knownThreads.get(owner)?.busy, busy);
          const status = yield* service.status({ monitorId: started.monitor.id });
          assert.strictEqual(status.monitor?.ownerThreadId, owner);
          const launch = yield* store.latestFallbackLaunch(started.monitor.id);
          assert.isNull(launch);
          assert.include(status.automationBlockReason ?? "", "protect existing Copilot work");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              currentSettings = defaultSettings;
              currentSnapshot = sampleSnapshot();
            }),
          ),
        ),
    );
  }

  it.effect("reconsiders pending fallback after opt-in without requiring new feedback", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const instanceId = ProviderInstanceId.make("copilot");
      currentSettings = {
        ...defaultSettings,
        textGenerationModelSelection: { instanceId, model: "gpt-test" },
      };
      currentSnapshot = sampleSnapshot({
        checkRuns: [
          {
            id: "resume-check",
            name: "ci",
            status: "failure",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });
      const input = { projectId, repository: "acme/app", number: 350 };
      const started = yield* service.start(input);
      assert.isNull(started.monitor.ownerThreadId);
      const settings = yield* ServerSettingsService;
      const takeover = yield* service.subscribeList({ projectId }).pipe(
        Stream.filter((result) =>
          result.monitors.some(
            (monitor) => monitor.id === started.monitor.id && monitor.ownerThreadId !== null,
          ),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* settings.updateSettings({ copilotAutomaticPrFeedback: { [instanceId]: true } });
      yield* Fiber.join(takeover);
      const status = yield* service.status({ monitorId: started.monitor.id });
      assert.isNotNull(status.monitor?.ownerThreadId);
      assert.isUndefined(status.automationBlockReason);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          currentSettings = defaultSettings;
          currentSnapshot = sampleSnapshot();
          monitorSnapshotHook = Effect.void;
        }),
      ),
    ),
  );

  it.effect("launchFallback relaunches when cooldown owner is deleted", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 51,
      });
      const first = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-missing",
      });
      assert.isTrue(first.launched);
      // Simulate dead fallback owner while still recorded on the monitor.
      knownThreads.delete(first.fallbackThreadId);

      const second = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-unavailable",
      });
      assert.isTrue(second.launched);
      assert.notStrictEqual(second.fallbackThreadId, first.fallbackThreadId);
      assert.strictEqual(second.previousOwnerThreadId, first.fallbackThreadId);
    }),
  );

  it.effect("launchFallback refuses available owner without force", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_owner_live");
      seedThread(owner);
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 48,
        ownerThreadId: owner,
      });

      const refused = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "explicit",
        }),
      );
      assert.strictEqual(refused._tag, "Failure");

      const forced = yield* service.launchFallback({
        monitorId: started.monitor.id,
        reason: "explicit",
        force: true,
      });
      assert.isTrue(forced.launched);
      assert.strictEqual(forced.previousOwnerThreadId, owner);
      assert.notStrictEqual(forced.fallbackThreadId, owner);
    }),
  );

  it.effect("launchFallback does not transfer ownership when prep fails", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 49,
      });
      preparePrWorktreePath = null;
      const result = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "owner-missing",
        }),
      );
      preparePrWorktreePath = "/tmp/pr-head";
      assert.strictEqual(result._tag, "Failure");
      const status = yield* service.status({ monitorId: started.monitor.id });
      assert.isNull(status.monitor?.ownerThreadId ?? null);
    }),
  );

  it.effect("launchFallback serializes concurrent attempts with a lease", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const monitorStore = yield* PullRequestMonitorStore.make;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 52,
      });
      // Hold the fallback lease so a concurrent launch cannot dual-start agents.
      const now = "2026-08-11T00:00:00.000Z";
      const held = yield* monitorStore.tryAcquireLease({
        canonicalKey: `fallback:${started.monitor.canonicalKey}`,
        ownerId: "holder",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(held);

      const blocked = yield* Effect.result(
        service.launchFallback({
          monitorId: started.monitor.id,
          reason: "owner-missing",
        }),
      );
      assert.strictEqual(blocked._tag, "Failure");
      yield* monitorStore.releaseLease(held!);
    }),
  );

  it.effect("feedback state append/remove keep circuit fields atomic", () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMonitorService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const started = yield* service.start({
        projectId,
        repository: "acme/app",
        number: 50,
      });
      const now = "2026-08-11T00:00:00.000Z";

      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-a"],
        debounceUntil: "2026-08-11T00:00:15.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-b"],
        debounceUntil: "2026-08-11T00:00:30.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.setDeliveryCircuitState({
        monitorId: started.monitor.id,
        deliveryFailureCount: 2,
        circuitOpenUntil: "2026-08-11T00:05:00.000Z",
        updatedAt: now,
      });
      yield* feedbackStore.removePendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: ["revision-a"],
        updatedAt: now,
      });

      const state = yield* feedbackStore.getState(started.monitor.id);
      assert.deepStrictEqual(state.pendingRevisionIds, ["revision-b"]);
      assert.strictEqual(state.deliveryFailureCount, 2);
      assert.strictEqual(state.circuitOpenUntil, "2026-08-11T00:05:00.000Z");
    }),
  );

  it.effect("parks a resolved claim until fresh provider state confirms it", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const owner = ThreadId.make("thr_feedback_owner");
      seedThread(owner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 46,
        ownerThreadId: owner,
      });

      const event = {
        kind: "check-failed" as const,
        sourceId: "check-ci",
        detail: "ci failed",
        edited: false,
      };
      const failing = sampleSnapshot({
        checkRuns: [
          {
            id: "check-ci",
            name: "ci",
            status: "failure",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: failing,
        events: [event],
      });
      const afterIngest = yield* feedback.context({
        monitorId: started.monitor.id,
        includeClosed: true,
        resolveMonitor: () => Effect.succeed(started.monitor),
      });
      assert.strictEqual(afterIngest.items.length, 1);
      const item = afterIngest.items[0]!;
      assert.strictEqual(item.status, "open");
      assert.isNull(item.disposition);

      // Agent prose alone must not close a finding.
      const reported = yield* feedback.report({
        monitorId: started.monitor.id,
        itemId: item.id,
        disposition: "resolved",
        note: "fixed",
        reporterThreadId: owner,
        resolveMonitor: () => Effect.succeed(started.monitor),
        requestRecheck: () => Effect.void,
      });
      assert.isTrue(reported.awaitingVerification);
      assert.strictEqual(reported.item.status, "verifying");

      // Still failing upstream: the claim is rejected and the finding reopens.
      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: failing,
        events: [],
      });
      const stillOpen = yield* feedback
        .context({
          monitorId: started.monitor.id,
          includeClosed: true,
          resolveMonitor: () => Effect.succeed(started.monitor),
        })
        .pipe(Effect.map((result) => result.items.find((row) => row.id === item.id)));
      assert.strictEqual(stillOpen?.status, "open");

      // Provider now reports success: the finding closes on provider evidence.
      const passing = sampleSnapshot({
        checkRuns: [
          {
            id: "check-ci",
            name: "ci",
            status: "success",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });
      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: passing,
        events: [],
      });
      const closed = yield* feedback
        .context({
          monitorId: started.monitor.id,
          includeClosed: true,
          resolveMonitor: () => Effect.succeed(started.monitor),
        })
        .pipe(Effect.map((result) => result.items.find((row) => row.id === item.id)));
      assert.strictEqual(closed?.status, "closed");
      assert.strictEqual(closed?.disposition, "resolved-upstream");
    }),
  );

  it.effect("ingests the same observation twice without queueing it twice", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_replay_owner");
      seedThread(owner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 61,
        ownerThreadId: owner,
      });
      const snapshot = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-replay",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      const event = {
        kind: "new-review-comment" as const,
        sourceId: "thread-replay",
        detail: "please fix",
      };

      yield* feedback.reconcileAndIngest({ monitor: started.monitor, snapshot, events: [event] });
      const first = yield* feedbackStore.getState(started.monitor.id);
      assert.strictEqual(first.pendingRevisionIds.length, 1);

      // Replaying the identical observation is a no-op: identity is source content.
      yield* feedback.reconcileAndIngest({ monitor: started.monitor, snapshot, events: [event] });
      const second = yield* feedbackStore.getState(started.monitor.id);
      assert.deepStrictEqual(second.pendingRevisionIds, first.pendingRevisionIds);

      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items.length, 1);
      const revisions = yield* feedbackStore.listRevisionsByIds(first.pendingRevisionIds);
      assert.strictEqual(revisions.length, 1);
    }),
  );

  it.effect("rejects an unexpired lease and fences superseded poll commits", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 62,
      });
      const now = "2026-08-11T00:00:00.000Z";
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-1",
        nowIso: now,
        expiresAt: "2026-08-11T00:01:30.000Z",
      });
      assert.isNotNull(lease);

      // A second attempt cannot claim the same monitor while the lease is live,
      // even from the same process.
      const blocked = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-2",
        nowIso: now,
        expiresAt: "2026-08-11T00:01:30.000Z",
      });
      assert.isNull(blocked);

      // After expiry the next attempt wins with a higher generation.
      const afterExpiry = "2026-08-11T00:02:00.000Z";
      const next = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-3",
        nowIso: afterExpiry,
        expiresAt: "2026-08-11T00:03:30.000Z",
      });
      assert.isNotNull(next);
      assert.isTrue(next!.generation > lease!.generation);
      assert.isFalse(yield* store.holdsLease(lease!, afterExpiry));

      // The superseded generation cannot commit: its write is fenced out.
      const stale = yield* store.commitPollObservation({
        lease: lease!,
        cursor: emptyCursor(),
        snapshotId: "snap-stale",
        snapshot: sampleSnapshot(),
        events: [],
        ingest: Effect.succeed({
          openCount: 0,
          verifyingCount: 0,
          needsHumanCount: 0,
          pendingDeliveryCount: 0,
        }),
        finalize: () => ({
          record: { ...started.monitor, lastError: "stale write" },
          readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
        }),
      });
      assert.isFalse(stale.committed);
      const unchanged = yield* store.getById(started.monitor.id);
      assert.isNull(unchanged?.lastError ?? null);

      // Releasing is fenced too: the stale generation cannot drop the live lease.
      yield* store.releaseLease(lease!);
      assert.isTrue(yield* store.holdsLease(next!, afterExpiry));
      yield* store.releaseLease(next!);
    }),
  );

  it.effect("fences a poll whose provider read outlived the attempt lease", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const sql = yield* SqlClient.SqlClient;

      currentSnapshot = sampleSnapshot({
        sourceRevision: "rev-fenced",
        reviewThreads: [
          {
            id: "thread-fenced",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "1970-01-01T00:00:00.000Z",
            updatedAt: "1970-01-01T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      // The provider read itself outlives the TTL the attempt was granted.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        currentSnapshot = sampleSnapshot();
        // Park the scheduler so the only writers in this race are the two workers.
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
      });

      const started = yield* monitors.start({ projectId, repository: "acme/app", number: 69 });

      // An expired attempt commits nothing: no state, snapshot, cursor, or feedback.
      const record = yield* store.getById(started.monitor.id);
      assert.strictEqual(record?.status, "monitoring");
      assert.isNull(record?.lastPolledAt ?? null);
      assert.isNull(record?.readiness ?? null);
      assert.isNull(record?.lastError ?? null);
      const cursor = yield* store.getCursor(started.monitor.id);
      assert.notStrictEqual(cursor.sourceRevision, "rev-fenced");
      assert.isNull(yield* store.latestSnapshot(started.monitor.id));
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.deepStrictEqual(items, []);

      // The lease really was free: the worker that claims it next is the one that writes.
      const now = yield* isoNow;
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "worker-next",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(lease);
      const commit = yield* store.commitPollObservation({
        lease: lease!,
        cursor: { ...emptyCursor(), sourceRevision: "rev-worker-next" },
        snapshotId: "snap-worker-next",
        snapshot: sampleSnapshot({
          sourceRevision: "rev-worker-next",
          fetchedAt: "2026-08-12T00:00:00.000Z",
        }),
        events: [],
        ingest: Effect.succeed(emptyFeedbackReadiness),
        finalize: (_feedback, commitAt) => ({
          record: { ...started.monitor, lastPolledAt: commitAt, updatedAt: commitAt },
          readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
        }),
      });
      assert.isTrue(commit.committed);
      const latest = yield* store.latestSnapshot(started.monitor.id);
      assert.strictEqual(latest?.snapshot.sourceRevision, "rev-worker-next");
      yield* store.releaseLease(lease!);
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("a poll failing after its lease expired cannot clobber a newer poll", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const sql = yield* SqlClient.SqlClient;
      const reference = { projectId, repository: "acme/app", number: 70 } as const;

      currentSnapshot = sampleSnapshot({ sourceRevision: "rev-healthy" });
      const started = yield* monitors.start(reference);
      assert.isNull(started.monitor.lastError);

      // A crash after the lease expired, while a newer worker already committed.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
        const now = yield* isoNow;
        const newer = yield* store
          .tryAcquireLease({
            canonicalKey: started.monitor.canonicalKey,
            ownerId: "worker-newer",
            nowIso: now,
            expiresAt: addMs(now, LEASE_TTL_MS),
          })
          .pipe(Effect.orDie);
        assert.isNotNull(newer);
        const commit = yield* store
          .commitPollObservation({
            lease: newer!,
            cursor: { ...emptyCursor(), sourceRevision: "rev-newer" },
            snapshotId: "snap-newer",
            snapshot: sampleSnapshot({
              sourceRevision: "rev-newer",
              fetchedAt: "2026-08-12T00:00:00.000Z",
            }),
            events: [],
            ingest: Effect.succeed(emptyFeedbackReadiness),
            finalize: (_feedback, commitAt) => ({
              record: {
                ...started.monitor,
                status: "monitoring" as const,
                lastError: null,
                pollFailureCount: 0,
                lastPolledAt: commitAt,
                nextPollAt: "2099-01-01T00:00:00.000Z",
                updatedAt: commitAt,
              },
              readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
            }),
          })
          .pipe(Effect.orDie);
        assert.isTrue(commit.committed);
        yield* store.releaseLease(newer!).pipe(Effect.orDie);
        return yield* Effect.die(new Error("stale worker crashed"));
      });
      yield* monitors.start(reference);

      const afterDefect = yield* store.getById(started.monitor.id);
      assert.strictEqual(afterDefect?.status, "monitoring");
      assert.isNull(afterDefect?.lastError ?? null);
      assert.strictEqual(afterDefect?.pollFailureCount, 0);
      assert.strictEqual(
        (yield* store.latestSnapshot(started.monitor.id))?.snapshot.sourceRevision,
        "rev-newer",
      );

      // Typed provider failures are fenced by the same expiry, with no newer writer.
      monitorSnapshotHook = Effect.gen(function* () {
        monitorSnapshotHook = Effect.void;
        yield* sql`UPDATE pull_request_monitors SET next_poll_at = '2099-01-01T00:00:00.000Z'`.pipe(
          Effect.orDie,
        );
        yield* TestClock.adjust(Duration.millis(LEASE_TTL_MS + 1_000));
        return yield* new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "host unreachable after a long read",
        });
      });
      yield* monitors.start(reference);

      const afterFailure = yield* store.getById(started.monitor.id);
      assert.notStrictEqual(afterFailure?.status, "error");
      assert.isNull(afterFailure?.lastError ?? null);
      assert.strictEqual(afterFailure?.pollFailureCount, 0);
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("a poll that cannot claim the lease leaves monitor state untouched", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const reference = { projectId, repository: "acme/app", number: 71 } as const;
      const started = yield* monitors.start(reference);
      const before = yield* store.getById(started.monitor.id);

      const now = yield* isoNow;
      const held = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "worker-holding",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(held);

      yield* monitors.start(reference);
      const after = yield* store.getById(started.monitor.id);
      assert.strictEqual(after?.lastPolledAt ?? null, before?.lastPolledAt ?? null);
      assert.isNull(after?.lastError ?? null);
      assert.strictEqual(after?.pollFailureCount, 0);
      yield* store.releaseLease(held!);
    }),
  );

  it.effect("rolls the cursor back when ingestion fails mid-poll", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 63,
      });
      const before = yield* store.getCursor(started.monitor.id);
      const now = "2026-08-11T00:00:00.000Z";
      const lease = yield* store.tryAcquireLease({
        canonicalKey: started.monitor.canonicalKey,
        ownerId: "attempt-ingest",
        nowIso: now,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.isNotNull(lease);

      const failed = yield* Effect.result(
        store.commitPollObservation({
          lease: lease!,
          cursor: { ...emptyCursor(), sourceRevision: "rev-next", headSha: "next-head" },
          snapshotId: "snap-atomic",
          snapshot: sampleSnapshot(),
          events: [],
          ingest: Effect.fail(
            new PullRequestMonitorError({ message: "ingest exploded" }),
          ) as Effect.Effect<never, PullRequestMonitorError>,
          finalize: () => ({
            record: started.monitor,
            readiness: { ready: true, label: "no-known-blockers" as const, blockers: [] },
          }),
        }),
      );
      assert.strictEqual(failed._tag, "Failure");

      const after = yield* store.getCursor(started.monitor.id);
      assert.strictEqual(after.sourceRevision, before.sourceRevision);
      const snapshotRow = yield* store.latestSnapshot(started.monitor.id);
      assert.notStrictEqual(snapshotRow?.snapshot.sourceRevision, "rev-next");
      yield* store.releaseLease(lease!);
    }),
  );

  it.effect("rejects oversized internal handoffs before creating a monitor", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const reference = { projectId, repository: "acme/app", number: 9067 };
      const result = yield* Effect.result(
        monitors.submitFindings({
          reference,
          reviewThreadId: ThreadId.make("oversized-review"),
          findings: [{ title: "Oversized", detail: "a".repeat(64 * 1024), severity: "major" }],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      const context = yield* monitors.context({ reference });
      assert.isNull(context.monitor);
    }),
  );

  it.effect("submits structured findings as individually addressable feedback", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_findings_owner");
      const reviewer = ThreadId.make("thr_findings_review");
      seedThread(owner);
      seedThread(reviewer);
      yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 64,
        ownerThreadId: owner,
      });

      const submitted = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number: 64 },
        reviewThreadId: reviewer,
        reviewedHeadSha: "deadbeef",
        ownerThreadId: owner,
        summary: "two findings",
        findings: [
          {
            key: "finding-a",
            title: "Unbounded query",
            detail: "Add a limit.\n".repeat(500),
            severity: "major",
            path: "src/a.ts",
            line: 12,
          },
          {
            title: "Typo",
            detail: "Fix the message.",
            severity: "nit",
          },
        ],
      });

      assert.strictEqual(submitted.linkedReviewThreadId, reviewer);
      assert.strictEqual(submitted.ownerThreadId, owner);
      assert.strictEqual(submitted.findings.length, 2);
      assert.isTrue(submitted.findings.every((finding) => finding.created));
      assert.strictEqual(new Set(submitted.findings.map((f) => f.itemId)).size, 2);
      assert.strictEqual(new Set(submitted.findings.map((f) => f.revisionId)).size, 2);

      const context = yield* monitors.context({
        monitorId: submitted.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(context.items.filter((item) => item.kind === "review-finding").length, 2);
      const exact = yield* monitors.context({
        monitorId: submitted.monitor.id,
        revisionIds: [submitted.findings[0]!.revisionId],
      });
      assert.strictEqual(exact.findingDetails?.[0]?.finding?.detail, "Add a limit.\n".repeat(500));
      assert.strictEqual(exact.findingDetails?.[0]?.contentStatus, "complete");
      const page = yield* monitors.context({ monitorId: submitted.monitor.id, limit: 1 });
      assert.strictEqual(page.revisions?.length, 1);
      assert.strictEqual(page.nextOffset, 1);
      const next = yield* monitors.context({
        monitorId: submitted.monitor.id,
        limit: 1,
        offset: 1,
      });
      assert.strictEqual(next.nextOffset, null);
      assert.notStrictEqual(page.revisions?.[0]?.id, next.revisions?.[0]?.id);

      // Re-submitting the same findings is idempotent per source revision.
      const again = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number: 64 },
        reviewThreadId: reviewer,
        findings: [
          {
            key: "finding-a",
            title: "Unbounded query",
            detail: "Add a limit.\n".repeat(500),
            severity: "major",
            path: "src/a.ts",
            line: 12,
          },
        ],
      });
      assert.isFalse(again.findings[0]!.created);
      const other = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 9065,
        ownerThreadId: owner,
      });
      const forbidden = yield* Effect.result(
        monitors.context({
          monitorId: other.monitor.id,
          revisionIds: [submitted.findings[0]!.revisionId],
        }),
      );
      assert.strictEqual(forbidden._tag, "Failure");
    }),
  );

  it.effect(
    "keeps review findings visible on a stopped, owner-recovered monitor without enabling it",
    () =>
      Effect.gen(function* () {
        const monitors = yield* PullRequestMonitorService;
        const feedback = yield* PullRequestMonitorFeedbackService;
        const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
        const owner = ThreadId.make("review-feedback-recovered-owner");
        const reviewer = ThreadId.make("review-feedback-child");
        const reference = { projectId, repository: "acme/app", number: 73 } as const;
        const association = {
          number: reference.number,
          url: `https://github.com/${reference.repository}/pull/${reference.number}`,
        };
        seedThread(owner, "/tmp/owner", association);
        seedThread(reviewer);
        currentSnapshot = sampleSnapshot({ number: reference.number, url: association.url });

        const submitted = yield* monitors.submitFindings({
          reference,
          reviewThreadId: reviewer,
          reviewedHeadSha: "reviewed-head-73",
          startMonitoring: false,
          findings: [
            {
              key: "paused-review-finding",
              title: "Persist while paused",
              detail: "The parent needs to see this without starting a turn.",
              severity: "major",
            },
          ],
        });
        const context = yield* monitors.context({ monitorId: submitted.monitor.id });
        const status = yield* monitors.status({ monitorId: submitted.monitor.id });

        assert.strictEqual(submitted.monitor.enabled, false);
        assert.strictEqual(submitted.monitor.status, "stopped");
        assert.strictEqual(submitted.ownerThreadId, owner);
        assert.strictEqual(
          yield* monitors.automationDeliveryState({ reference, threadId: owner }),
          "blocked",
        );
        assert.strictEqual(
          context.items.some((item) => item.summary.includes("Persist while paused")),
          true,
        );
        assert.strictEqual(status.ownerCandidates.length, 1);
        const state = yield* feedbackStore.getState(submitted.monitor.id);
        yield* feedbackStore.appendPendingRevisionIds({
          monitorId: submitted.monitor.id,
          revisionIds: state.pendingRevisionIds,
          debounceUntil: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        });
        dispatchedCommands.length = 0;
        const queueCountBefore = queuedMessages.length;
        yield* feedback.flushDueDeliveries;
        const deliveries = yield* feedbackStore.listDeliveries({ monitorId: submitted.monitor.id });
        assert.strictEqual(deliveries[0]?.status, "delivered");
        assert.isTrue(
          dispatchedCommands.some(
            (command) => command.type === "thread.queued-turn.create" && command.threadId === owner,
          ),
        );
        assert.strictEqual(queuedMessages.length, queueCountBefore + 1);
        assert.include(queuedMessages.at(-1) ?? "", "Persist while paused");
        assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));
        const queueCommands = dispatchedCommands.filter(
          (command) => command.type === "thread.queued-turn.create",
        ).length;
        yield* feedback.flushDueDeliveries;
        assert.strictEqual(
          dispatchedCommands.filter((command) => command.type === "thread.queued-turn.create")
            .length,
          queueCommands,
        );
        yield* monitors.start({ ...reference, ownerThreadId: owner });
        assert.strictEqual(
          yield* monitors.automationDeliveryState({ reference, threadId: owner }),
          "eligible",
        );
        currentSettings = { ...defaultSettings, autoMonitorPullRequestsOnCreate: false };
        const policyDisabled = yield* monitors
          .automationDeliveryState({ reference, threadId: owner })
          .pipe(Effect.ensuring(Effect.sync(() => (currentSettings = defaultSettings))));
        assert.strictEqual(policyDisabled, "blocked");
        currentSnapshot = sampleSnapshot();
      }),
  );

  it.effect("preserves a human owner selected while review findings are being submitted", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const sql = yield* SqlClient.SqlClient;
      const recoveredOwner = ThreadId.make("submit-findings-recovered-owner");
      const explicitOwner = ThreadId.make("submit-findings-explicit-owner");
      const reviewer = ThreadId.make("submit-findings-reviewer");
      const reference = { projectId, repository: "acme/app", number: 78 } as const;
      const association = {
        number: reference.number,
        url: `https://github.com/${reference.repository}/pull/${reference.number}`,
      };
      seedThread(recoveredOwner, "/tmp/recovered-owner", association);
      seedThread(explicitOwner);
      seedThread(reviewer);
      currentSnapshot = sampleSnapshot({ number: reference.number, url: association.url });

      const started = yield* monitors.start({ ...reference, ownerMode: "observe-only" });
      assert.isNull(started.monitor.ownerThreadId);
      monitorSnapshotHook = monitors
        .transferOwnership({
          monitorId: started.monitor.id,
          toThreadId: explicitOwner,
          reason: "human-owner-selection",
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new PullRequestOperationError({
                operation: "monitorSnapshot",
                detail: "Could not inject the concurrent owner selection.",
              }),
          ),
        );

      const submitted = yield* monitors
        .submitFindings({
          reference,
          reviewThreadId: reviewer,
          startMonitoring: false,
          findings: [
            {
              key: "owner-race-finding",
              title: "Keep the manual owner",
              detail: "The recovery claim must not overwrite a human selection.",
              severity: "major",
            },
          ],
        })
        .pipe(Effect.ensuring(Effect.sync(() => (monitorSnapshotHook = Effect.void))));
      const persisted = yield* monitors.status({ monitorId: started.monitor.id });
      const events = yield* sql<{
        readonly from_thread_id: string | null;
        readonly to_thread_id: string | null;
      }>`
        SELECT from_thread_id, to_thread_id
        FROM pull_request_monitor_ownership_events
        WHERE monitor_id = ${started.monitor.id}
        ORDER BY created_at
      `;

      assert.strictEqual(submitted.ownerThreadId, explicitOwner);
      assert.strictEqual(submitted.monitor.ownerThreadId, explicitOwner);
      assert.strictEqual(persisted.monitor?.ownerThreadId, explicitOwner);
      assert.strictEqual(persisted.monitor?.linkedReviewThreadId, reviewer);
      assert.deepStrictEqual(events, [{ from_thread_id: null, to_thread_id: explicitOwner }]);
    }),
  );

  it.effect("preserves review findings without choosing between ambiguous active owners", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const ownerA = ThreadId.make("ambiguous-review-owner-a");
      const ownerB = ThreadId.make("ambiguous-review-owner-b");
      const reviewer = ThreadId.make("ambiguous-review-child");
      const number = 74;
      const url = `https://github.com/acme/app/pull/${number}`;
      seedThread(ownerA, "/tmp/owner-a", { number, url });
      seedThread(ownerB, "/tmp/owner-b", { number, url });
      seedThread(reviewer);
      currentSnapshot = sampleSnapshot({ number, url });

      const submitted = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number },
        reviewThreadId: reviewer,
        startMonitoring: false,
        findings: [
          {
            key: "ambiguous-review-owner-finding",
            title: "Owner is ambiguous",
            detail: "Persist it for the PR surface without sending it to either thread.",
            severity: "major",
          },
        ],
      });
      const status = yield* monitors.status({ monitorId: submitted.monitor.id });
      const context = yield* monitors.context({ monitorId: submitted.monitor.id });

      assert.isNull(submitted.ownerThreadId);
      assert.deepStrictEqual(
        status.ownerCandidates.map((candidate) => candidate.threadId).sort(),
        [ownerA, ownerB].sort(),
      );
      assert.strictEqual(context.items.length, 1);
      const feedbackState = yield* feedbackStore.getState(submitted.monitor.id);
      assert.deepStrictEqual(feedbackState.pendingRevisionIds, [submitted.findings[0]!.revisionId]);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: submitted.monitor.id,
        revisionIds: feedbackState.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));

      // Human ownership resolution unblocks delivery without creating a new review revision.
      yield* monitors.transferOwnership({
        monitorId: submitted.monitor.id,
        toThreadId: ownerA,
        reason: "selected after ambiguous review handoff",
      });
      const recovered = yield* monitors.status({ monitorId: submitted.monitor.id });
      assert.strictEqual(recovered.monitor?.ownerThreadId, ownerA);
      const pendingMonitors = yield* (yield* PullRequestMonitorStore.make).listPendingFeedbackPage({
        limit: 500,
      });
      assert.isTrue(pendingMonitors.some((pending) => pending.monitor.id === submitted.monitor.id));
      yield* feedback.flushDueDeliveries;
      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: submitted.monitor.id });
      assert.strictEqual(deliveries[0]?.targetThreadId, ownerA);
      assert.strictEqual(deliveries[0]?.status, "delivered");
      assert.isTrue(
        dispatchedCommands.some(
          (command) => command.type === "thread.queued-turn.create" && command.threadId === ownerA,
        ),
      );
      assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("persists immutable acceptance provenance with the finding revision", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const owner = ThreadId.make("thr_acceptance_owner");
      const reviewer = ThreadId.make("thr_acceptance_review");
      seedThread(owner);
      seedThread(reviewer);

      const submitted = yield* monitors.submitFindings({
        reference: { projectId, repository: "acme/app", number: 9069 },
        reviewThreadId: reviewer,
        reviewedHeadSha: "deadbeef",
        ownerThreadId: owner,
        findings: [
          {
            key: "acceptance-finding",
            title: "Acceptance evidence",
            detail: "Preserve the exact review provenance.",
            severity: "major",
            acceptanceProvenance: {
              caseId: CollaborativeAcceptanceCaseId.make("case-acceptance"),
              candidateId: CollaborativeAcceptanceCandidateId.make("candidate-1"),
              transportContext: {
                caseId: CollaborativeAcceptanceCaseId.make("case-acceptance"),
                exchangeId: CollaborativeAcceptanceExchangeId.make("exchange-1"),
              },
              headSha: "deadbeef",
              sourceRevision: "provider-source-1",
              workflow: { identity: "review-workflow", version: "2" },
              requiredCoverage: {
                required: ["diff", "threads"],
                covered: ["diff"],
                applicability: "known",
              },
              diffHash: "diff-acceptance",
              location: {
                path: "src/example.ts",
                side: "new",
                startLine: 8,
                endLine: 9,
              },
            },
          },
        ],
      });

      const context = yield* monitors.context({
        monitorId: submitted.monitor.id,
        revisionIds: [submitted.findings[0]!.revisionId],
      });
      const payload = context.revisions?.[0]?.payload as {
        readonly acceptanceProvenance?: unknown;
      };
      assert.deepStrictEqual(payload.acceptanceProvenance, {
        monitorId: submitted.monitor.id,
        caseId: "case-acceptance",
        candidateId: "candidate-1",
        transportContext: {
          caseId: "case-acceptance",
          exchangeId: "exchange-1",
        },
        headSha: "deadbeef",
        sourceRevision: "provider-source-1",
        findingId: submitted.findings[0]!.itemId,
        findingRevisionId: submitted.findings[0]!.revisionId,
        workflow: { identity: "review-workflow", version: "2" },
        requiredCoverage: {
          required: ["diff", "threads"],
          covered: ["diff"],
          applicability: "known",
        },
        diffHash: "diff-acceptance",
        location: {
          path: "src/example.ts",
          side: "new",
          startLine: 8,
          endLine: 9,
        },
      });
    }),
  );

  it.effect(
    "delivers a manual review body intact and retrieves its immutable delivered revision",
    () =>
      Effect.gen(function* () {
        const monitors = yield* PullRequestMonitorService;
        const feedback = yield* PullRequestMonitorFeedbackService;
        const store = yield* PullRequestMonitorFeedbackStore.make;
        const owner = ThreadId.make("full-context-owner");
        const reviewer = ThreadId.make("full-context-reviewer");
        seedThread(owner);
        seedThread(reviewer);
        yield* monitors.start({
          projectId,
          repository: "acme/app",
          number: 9066,
          ownerThreadId: owner,
        });
        const body = "Full review evidence beyond the old limit.\n".repeat(100);
        const input = handoffToSubmitInput({
          projectId,
          reviewThreadId: reviewer,
          repository: "acme/app",
          number: 9066,
          headSha: "deadbeef",
          diffHash: "diff-full-context",
          summary: "Manual review",
          findings: [
            {
              id: "finding-1",
              title: "Preserve context",
              body,
              priority: "high",
              location: { path: "a.ts", side: "new", startLine: 1, endLine: 3 },
            },
          ],
        });
        const submitted = yield* monitors.submitFindings(input);
        const state = yield* store.getState(submitted.monitor.id);
        yield* store.appendPendingRevisionIds({
          monitorId: submitted.monitor.id,
          revisionIds: state.pendingRevisionIds,
          debounceUntil: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        });
        const before = queuedMessages.length;
        yield* feedback.flushDueDeliveries;
        assert.isTrue(queuedMessages.slice(before).some((text) => text.includes(body)));
        const [delivery] = yield* store.listDeliveries({ monitorId: submitted.monitor.id });
        assert.isDefined(delivery);
        const updated = yield* monitors.submitFindings({
          ...input,
          findings: input.findings!.map((finding) => ({
            ...finding,
            detail: "New review evidence.",
          })),
        });
        const exact = yield* monitors.context({
          monitorId: submitted.monitor.id,
          deliveryId: delivery!.id,
        });
        assert.strictEqual(exact.findingDetails?.[0]?.finding?.detail, body);
        assert.strictEqual(
          exact.findingDetails?.[0]?.finding?.provenance?.diffHash,
          "diff-full-context",
        );
        assert.strictEqual(exact.revisions?.[0]?.id, submitted.findings[0]?.revisionId);
        assert.strictEqual(exact.items[0]?.currentRevisionId, updated.findings[0]?.revisionId);
        assert.notStrictEqual(exact.revisions?.[0]?.id, exact.items[0]?.currentRevisionId);
      }),
  );

  it.effect("queues complete scoped evidence before a no-tool owner can start remediation", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const store = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("no-tool-context-owner");
      const reviewer = ThreadId.make("no-tool-context-reviewer");
      seedThread(owner);
      seedThread(reviewer);
      knownThreads.set(owner, { ...knownThreads.get(owner)!, instanceId: "codex" });
      const reference = { projectId, repository: "acme/app", number: 9068 };
      yield* monitors.start({ ...reference, ownerThreadId: owner });
      const bodies = [
        "First finding evidence.\n".repeat(800),
        "Second finding evidence.\n".repeat(800),
      ];
      const submitted = yield* monitors.submitFindings({
        reference,
        reviewThreadId: reviewer,
        findings: bodies.map((detail, index) => ({
          key: `complete-${index}`,
          title: `Complete finding ${index}`,
          severity: "major",
          detail,
        })),
      });
      const state = yield* store.getState(submitted.monitor.id);
      yield* store.appendPendingRevisionIds({
        monitorId: submitted.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      const before = queuedMessages.length;
      yield* feedback.flushDueDeliveries;
      const messages = queuedMessages.slice(before);
      assert.strictEqual(messages.length, 2);
      for (const [index, body] of bodies.entries()) {
        const message = messages.find((text) => text.includes(body));
        assert.isDefined(message);
        assert.isFalse(message!.includes(`Complete finding ${1 - index}`));
        assert.isFalse(message!.includes("Wait for all parts"));
        assert.isFalse(message!.includes("pr_monitor_context"));
      }
      yield* feedback.flushDueDeliveries;
      assert.strictEqual(queuedMessages.length - before, 2);
    }),
  );

  it.effect("preserves findings and reviewed-head provenance when the PR advances mid-review", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_stale_findings_owner");
      const reviewer = ThreadId.make("thr_stale_findings_review");
      seedThread(owner);
      seedThread(reviewer);
      const input = {
        reference: { projectId, repository: "acme/app", number: 64 },
        reviewThreadId: reviewer,
        ownerThreadId: owner,
        reviewedHeadSha: "stale-head",
        findings: [
          {
            key: "stale-finding",
            title: "Stale finding",
            detail: "This finding reviewed an earlier revision.",
            severity: "major" as const,
            provenance: {
              findingId: "finding-1",
              reviewedHeadSha: "stale-head",
              diffHash: "reviewed-diff-hash",
              path: "src/stale.ts",
              side: "new" as const,
              startLine: 4,
              endLine: 5,
            },
          },
        ],
      };

      const submitted = yield* monitors.submitFindings(input);

      assert.strictEqual(submitted.monitor.headSha, "deadbeef");
      assert.strictEqual(submitted.findings.length, 1);
      assert.isTrue(submitted.findings[0]!.created);
      const context = yield* monitors.context({
        monitorId: submitted.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(
        context.items.some((item) => item.summary.includes("Stale finding")),
        true,
      );
      const revision = context.revisions?.find(
        (entry) => entry.id === submitted.findings[0]!.revisionId,
      );
      assert.strictEqual(revision?.sourceRevision, "review:stale-head");
      const exact = context.findingDetails?.find(
        (entry) => entry.revisionId === submitted.findings[0]!.revisionId,
      );
      assert.strictEqual(exact?.reviewedHeadSha, "stale-head");
      assert.strictEqual(exact?.finding?.provenance?.reviewedHeadSha, "stale-head");

      const state = yield* feedbackStore.getState(submitted.monitor.id);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: submitted.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      dispatchedCommands.length = 0;
      const queuedBefore = queuedMessages.length;
      yield* feedback.flushDueDeliveries;
      const parentMessage = queuedMessages
        .slice(queuedBefore)
        .find((text) => text.includes("Stale finding"));
      assert.isDefined(parentMessage);
      assert.include(parentMessage!, "Head: deadbeef");
      assert.include(parentMessage!, "Compare reviewedHeadSha with the current code.");
      assert.isTrue(
        dispatchedCommands.some(
          (command) => command.type === "thread.queued-turn.create" && command.threadId === owner,
        ),
      );
      assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));

      // A handoff retry/replay for this reviewed revision must not fork another ledger revision.
      const replay = yield* monitors.submitFindings(input);
      assert.strictEqual(replay.findings[0]?.revisionId, submitted.findings[0]?.revisionId);
      assert.isFalse(replay.findings[0]?.created);
      const afterReplay = yield* monitors.context({
        monitorId: submitted.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(
        afterReplay.revisions?.filter((entry) => entry.id === submitted.findings[0]!.revisionId)
          .length,
        1,
      );
      const queuedReviewMessages = dispatchedCommands.filter(
        (command) => command.type === "thread.queued-turn.create",
      ).length;
      yield* feedback.flushDueDeliveries;
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.queued-turn.create").length,
        queuedReviewMessages,
      );
    }),
  );

  it.effect("queues remediation durably and can return it to delivery retry", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_delivery_owner");
      const newOwner = ThreadId.make("thr_delivery_new_owner");
      seedThread(owner);
      seedThread(newOwner);
      // The owner is mid-turn while the finding arrives.
      knownThreads.set(owner, {
        projectId,
        worktreePath: "/tmp/wt",
        archivedAt: null,
        busy: true,
        pullRequest: null,
      });

      const live = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-live",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      currentSnapshot = live;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 67,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: live,
        events: [{ kind: "new-review-comment", sourceId: "thread-live", detail: "please fix" }],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      assert.strictEqual(state.pendingRevisionIds.length, 1);
      // Mature the debounce window without waiting on the clock.
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "delivered");
      assert.isTrue(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      assert.isFalse(dispatchedCommands.some((command) => command.type === "thread.turn.start"));

      const delivery = deliveries[0]!;
      yield* monitors.transferOwnership({
        monitorId: started.monitor.id,
        toThreadId: newOwner,
        reason: "human-owner-selection",
      });
      assert.strictEqual(
        yield* monitors.automationDeliveryState({
          reference: { projectId, repository: "acme/app", number: 67 },
          threadId: owner,
        }),
        "owner-changed",
      );
      yield* feedback.retryQueuedDelivery({
        deliveryId: delivery.id,
        reason: "queued recipient no longer owns the monitor",
      });
      const retried = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(retried[0]?.status, "failed");
      assert.strictEqual(retried[0]?.deliveredAt, null);
      assert.strictEqual(retried[0]?.lastError, "queued recipient no longer owns the monitor");
      yield* feedbackStore.updateDelivery({
        ...retried[0]!,
        nextAttemptAt: "1970-01-01T00:00:00.000Z",
        receiptJson: null,
      });

      dispatchedCommands.length = 0;
      const queuedBeforeRetry = queuedMessages.length;
      yield* feedback.flushDueDeliveries;

      const redelivered = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(redelivered[0]?.status, "delivered");
      assert.strictEqual(redelivered[0]?.targetThreadId, newOwner);
      assert.notStrictEqual(redelivered[0]?.commandId, delivery.commandId);
      assert.notStrictEqual(redelivered[0]?.messageId, delivery.messageId);
      assert.isTrue(
        dispatchedCommands.some(
          (command) =>
            command.type === "thread.queued-turn.create" && command.threadId === newOwner,
        ),
      );
      assert.strictEqual(queuedMessages.length, queuedBeforeRetry + 1);
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("suppresses a wake when the provider resolved the finding first", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_stale_owner");
      seedThread(owner);

      const withThread = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-stale",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });
      currentSnapshot = withThread;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 68,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: withThread,
        events: [{ kind: "new-review-comment", sourceId: "thread-stale", detail: "please fix" }],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      // The reviewer resolves the thread before the batch matures.
      currentSnapshot = sampleSnapshot({
        reviewThreads: [
          {
            id: "thread-stale",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            resolved: true,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "suppressed");
      assert.isFalse(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items[0]?.status, "closed");
      assert.strictEqual(items[0]?.disposition, "resolved-upstream");
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect(
    "keeps parent findings and child disputes distinct until explicit reviewer agreement",
    () =>
      Effect.gen(function* () {
        const monitors = yield* PullRequestMonitorService;
        const sql = yield* SqlClient.SqlClient;
        const reviewer = ThreadId.make("thr_parent_review");
        const child = ThreadId.make("thr_child_dispute");
        seedThread(reviewer);
        seedThread(child);
        const originalSnapshot = currentSnapshot;
        const reference = { projectId, repository: "acme/app", number: 65 } as const;
        const submitted = yield* monitors.submitFindings({
          reference,
          reviewThreadId: reviewer,
          reviewedHeadSha: "deadbeef",
          findings: [
            {
              key: "parent-dispute",
              title: "Parent finding",
              detail: "Keep this evidence exact.",
              severity: "major",
            },
            {
              key: "parent-fixed",
              title: "Fixed finding",
              detail: "This is fixed on the next head.",
              severity: "minor",
            },
          ],
        });
        const disputeId = submitted.findings[0]!.itemId;
        const fixedId = submitted.findings[1]!.itemId;

        const rejected = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: disputeId,
          disposition: "rejected",
          note: "Child disputes the finding.",
          reporterThreadId: child,
        });
        assert.strictEqual(rejected.item.status, "open");
        assert.strictEqual(rejected.item.disposition, "rejected");
        assert.strictEqual(rejected.item.childDisposition, "rejected");
        assert.isNull(rejected.item.reviewerDisposition ?? null);

        const upheld = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: disputeId,
          disposition: "upheld",
          note: "Reviewer confirms the finding.",
          reporterThreadId: reviewer,
        });
        assert.strictEqual(upheld.item.status, "open");
        assert.strictEqual(upheld.item.disposition, "upheld");
        assert.strictEqual(upheld.item.childDisposition, "rejected");
        assert.strictEqual(upheld.item.reviewerDisposition, "upheld");

        const revised = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: disputeId,
          disposition: "revised",
          note: "Reviewer narrows the required change.",
          reporterThreadId: reviewer,
        });
        assert.strictEqual(revised.item.status, "open");
        assert.strictEqual(revised.item.disposition, "revised");
        assert.strictEqual(revised.item.reviewerDisposition, "revised");

        const needsHuman = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: disputeId,
          disposition: "needs-human",
          note: "The dispute needs an operator decision.",
          reporterThreadId: reviewer,
        });
        assert.strictEqual(needsHuman.item.status, "open");
        assert.strictEqual(needsHuman.item.reviewerDisposition, "needs-human");

        const agreedWithdrawal = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: disputeId,
          disposition: "withdrawn",
          note: "Reviewer agrees the child rejection is correct.",
          reporterThreadId: reviewer,
        });
        assert.strictEqual(agreedWithdrawal.item.status, "closed");
        assert.strictEqual(agreedWithdrawal.item.disposition, "rejected-with-reviewer-agreement");
        assert.strictEqual(agreedWithdrawal.item.childDisposition, "rejected");
        assert.strictEqual(agreedWithdrawal.item.reviewerDisposition, "withdrawn");

        currentSnapshot = sampleSnapshot({
          headSha: "feedface",
          sourceRevision: "rev-fixed",
        });
        const fixed = yield* monitors.report({
          monitorId: submitted.monitor.id,
          itemId: fixedId,
          disposition: "resolved",
          note: "Fixed on the new head.",
          reporterThreadId: child,
        });
        assert.strictEqual(fixed.item.status, "verifying");
        assert.strictEqual(fixed.item.disposition, "resolved");
        assert.isTrue(fixed.awaitingVerification);
        yield* sql`
          UPDATE pull_request_monitors
          SET next_poll_at = CASE
            WHEN monitor_id = ${submitted.monitor.id} THEN '1970-01-01T00:00:00.000Z'
            ELSE '2099-01-01T00:00:00.000Z'
          END
          WHERE enabled = 1
        `.pipe(Effect.orDie);
        yield* monitors.pollOnce;
        const verified = yield* monitors.context({
          monitorId: submitted.monitor.id,
          includeClosed: true,
        });
        const verifiedItem = verified.items.find((item) => item.id === fixedId);
        assert.strictEqual(verifiedItem?.status, "closed");
        assert.strictEqual(verifiedItem?.disposition, "resolved-upstream");
        currentSnapshot = originalSnapshot;
      }),
  );

  it.effect("delivers unresolved review feedback when the head moves before delivery", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_moved_head_owner");
      seedThread(owner);

      const unresolvedThread = {
        id: "thread-moved-head",
        author: { login: "reviewer", kind: "user" as const },
        path: "a.ts",
        line: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        resolved: false,
        latestCommentByViewer: false,
        bodyExcerpt: "still needs fixing",
      };
      const observed = sampleSnapshot({ reviewThreads: [unresolvedThread] });
      currentSnapshot = observed;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 69,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: observed,
        events: [
          {
            kind: "new-review-comment",
            sourceId: unresolvedThread.id,
            detail: unresolvedThread.bodyExcerpt,
          },
        ],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      // The provider head advances before the monitor's next poll, but the review
      // thread remains unresolved and therefore still requires owner attention.
      currentSnapshot = sampleSnapshot({
        headSha: "feedface",
        sourceRevision: "rev-2",
        reviewThreads: [unresolvedThread],
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "delivered");
      assert.isTrue(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      yield* feedback.flushDueDeliveries;
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.queued-turn.create").length,
        1,
      );
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items[0]?.status, "open");
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("suppresses a failed check from an older head before delivery", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_stale_check_owner");
      seedThread(owner);

      const failed = sampleSnapshot({
        checkRuns: [
          {
            id: "check-old-head",
            name: "ci",
            status: "failure",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });
      currentSnapshot = failed;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 70,
        ownerThreadId: owner,
      });

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: failed,
        events: [{ kind: "check-failed", sourceId: "check-old-head", detail: "ci" }],
      });
      const state = yield* feedbackStore.getState(started.monitor.id);
      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: state.pendingRevisionIds,
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      currentSnapshot = sampleSnapshot({
        headSha: "feedface",
        sourceRevision: "rev-2",
        checkRuns: [],
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(deliveries[0]?.status, "suppressed");
      assert.strictEqual(
        deliveries[0]?.lastError,
        "All findings in this batch were resolved upstream before delivery.",
      );
      assert.isFalse(
        dispatchedCommands.some((command) => command.type === "thread.queued-turn.create"),
      );
      const items = yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      });
      assert.strictEqual(items[0]?.status, "closed");
      assert.strictEqual(items[0]?.disposition, "superseded");
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("does not let a historical delivery close a newer revision", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const feedback = yield* PullRequestMonitorFeedbackService;
      const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
      const owner = ThreadId.make("thr_historical_delivery_owner");
      seedThread(owner);

      const oldFailure = sampleSnapshot({
        checkRuns: [
          {
            id: "check-stable-id",
            name: "ci",
            status: "failure",
            headSha: "deadbeef",
            url: null,
            description: null,
          },
        ],
      });
      currentSnapshot = oldFailure;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 71,
        ownerThreadId: owner,
      });
      const event = { kind: "check-failed" as const, sourceId: "check-stable-id", detail: "ci" };

      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: oldFailure,
        events: [event],
      });
      const oldState = yield* feedbackStore.getState(started.monitor.id);
      const [oldRevision] = yield* feedbackStore.listRevisionsByIds(oldState.pendingRevisionIds);
      assert.isDefined(oldRevision);
      const historicalDelivery = {
        id: "fb_del_historical_revision" as PullRequestMonitorFeedbackDeliveryId,
        monitorId: started.monitor.id,
        batchKey: "fb_batch_historical_revision",
        targetThreadId: owner,
        commandId: "command:historical-revision",
        messageId: "message:historical-revision",
        revisionIds: [oldRevision.id],
        status: "pending",
        attemptCount: 0,
        lastError: null,
        createdAt: "1969-12-31T23:59:59.000Z",
        deliveredAt: null,
      } as const;
      yield* feedbackStore.insertDelivery({
        ...historicalDelivery,
        nextAttemptAt: "9999-12-31T23:59:59.000Z",
        receiptJson: null,
      });
      yield* feedbackStore.removePendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: [oldRevision.id],
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      const newFailure = sampleSnapshot({
        headSha: "feedface",
        sourceRevision: "rev-2",
        checkRuns: [
          {
            id: "check-stable-id",
            name: "ci",
            status: "failure",
            headSha: "feedface",
            url: null,
            description: null,
          },
        ],
      });
      currentSnapshot = newFailure;
      yield* feedback.reconcileAndIngest({
        monitor: started.monitor,
        snapshot: newFailure,
        events: [event],
      });
      const newState = yield* feedbackStore.getState(started.monitor.id);
      const [newRevision] = yield* feedbackStore.listRevisionsByIds(newState.pendingRevisionIds);
      assert.isDefined(newRevision);
      assert.notStrictEqual(newRevision.id, oldRevision.id);
      yield* TestClock.adjust(Duration.millis(1));
      yield* feedbackStore.updateDelivery({
        ...historicalDelivery,
        nextAttemptAt: "1969-12-31T23:59:59.000Z",
        receiptJson: null,
      });

      dispatchedCommands.length = 0;
      yield* feedback.flushDueDeliveries;

      const item = (yield* feedbackStore.listItems({
        monitorId: started.monitor.id,
        includeClosed: true,
      }))[0];
      assert.strictEqual(item?.status, "open");
      assert.strictEqual(item?.currentRevisionId, newRevision.id);

      yield* feedbackStore.appendPendingRevisionIds({
        monitorId: started.monitor.id,
        revisionIds: [newRevision.id],
        debounceUntil: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      yield* feedback.flushDueDeliveries;

      const deliveries = yield* feedbackStore.listDeliveries({ monitorId: started.monitor.id });
      assert.strictEqual(
        deliveries.find((delivery) => delivery.id === "fb_del_historical_revision")?.status,
        "suppressed",
      );
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.queued-turn.create").length,
        1,
      );
      currentSnapshot = sampleSnapshot();
    }),
  );

  it.effect("interrupts a busy previous owner before handing ownership to a fallback", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const previousOwner = ThreadId.make("thr_busy_owner");
      seedThread(previousOwner);
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 65,
        ownerThreadId: previousOwner,
      });

      // The owner is gone from the shell but its turn is still running.
      knownThreads.set(previousOwner, {
        projectId,
        worktreePath: "/tmp/wt",
        archivedAt: "2026-08-11T00:00:00.000Z",
        busy: true,
        pullRequest: null,
      });
      dispatchedCommands.length = 0;

      const result = yield* monitors.launchFallback({
        monitorId: started.monitor.id,
        reason: "owner-unavailable",
      });
      assert.isTrue(result.launched);
      assert.strictEqual(result.previousOwnerThreadId, previousOwner);

      const interruptIndex = dispatchedCommands.findIndex(
        (command) => command.type === "thread.turn.interrupt",
      );
      const createIndex = dispatchedCommands.findIndex(
        (command) => command.type === "thread.create",
      );
      assert.isAbove(interruptIndex, -1);
      // The second modifying thread is only created after the first one is settled.
      assert.isAbove(createIndex, interruptIndex);

      const launch = yield* store.latestFallbackLaunch(started.monitor.id);
      assert.strictEqual(launch?.status, "launched");
      const monitor = yield* store.getById(started.monitor.id);
      assert.strictEqual(monitor?.ownerThreadId, result.fallbackThreadId);
    }),
  );

  it.effect("records fallback intent before any worktree or thread side effect", () =>
    Effect.gen(function* () {
      const monitors = yield* PullRequestMonitorService;
      const store = yield* PullRequestMonitorStore.make;
      const started = yield* monitors.start({
        projectId,
        repository: "acme/app",
        number: 66,
      });

      preparePrWorktreePath = null;
      const failed = yield* Effect.result(
        monitors.launchFallback({ monitorId: started.monitor.id, reason: "owner-missing" }),
      );
      preparePrWorktreePath = "/tmp/pr-head";
      assert.strictEqual(failed._tag, "Failure");

      const launch = yield* store.latestFallbackLaunch(started.monitor.id);
      assert.isNotNull(launch);
      assert.strictEqual(launch?.status, "failed");
      assert.isNotNull(launch?.error);
      // Ownership never moved, so nothing else can believe the fallback owns the PR.
      const monitor = yield* store.getById(started.monitor.id);
      assert.isNull(monitor?.ownerThreadId ?? null);
    }),
  );
});
