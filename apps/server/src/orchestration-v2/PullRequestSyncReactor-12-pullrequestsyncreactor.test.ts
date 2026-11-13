// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeV8 from "node:v8";

import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command as OrchestrationCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestStack,
  type PullRequestSummary,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestSyncReactor from "./PullRequestSyncReactor.ts";
import type { PullRequestTestThread } from "./testkit/pullRequestFixtures.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("sync-project");

type SyncCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.pull-request-link.sync" }
>;
type LinkCommand = Extract<OrchestrationCommand, { readonly type: "thread.pull-request.link" }>;

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));

function makeProject(id: ProjectId = PROJECT_ID): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<PullRequestTestThread> = {},
): PullRequestTestThread {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeLink(
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> | null = null,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repository",
    number,
    url: `https://github.com/owner/repository/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-08-27T00:00:00.000Z",
            syncedAt: "2026-08-27T00:00:00.000Z",
            ...snapshot,
          },
    stack: null,
    ...overrides,
  };
}

interface TestShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<PullRequestTestThread>;
  readonly updatedAt: string;
}

function makeSnapshot(
  threads: ReadonlyArray<PullRequestTestThread>,
  snapshotSequence = 1,
): TestShellSnapshot {
  return {
    snapshotSequence,
    projects: [makeProject()],
    threads,
    updatedAt: NOW,
  };
}

function makeSummary(
  input: PullRequestRef,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://github.com/${input.repository}/pull/${input.number}`,
    state: "open",
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly invalidate?: PullRequestService.PullRequestService["Service"]["invalidate"];
  readonly snapshot: TestShellSnapshot;
  readonly summary?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestSummary, PullRequestOperationError>;
  readonly stack?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestStack | null, PullRequestOperationError>;
  readonly onSync?: (command: SyncCommand) => Effect.Effect<unknown>;
}

const makeHarness = Effect.fn("makePullRequestSyncHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReads = yield* Queue.unbounded<void>();
  const shellSnapshotReads = yield* Ref.make(0);
  const syncCommands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const linkCommands = yield* Ref.make<ReadonlyArray<LinkCommand>>([]);
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const stackCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const stateChanges = yield* Queue.unbounded<ThreadPullRequestKey>();

  const summary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.recoverTransientFailure, false);
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      return yield* options.summary?.(input) ?? Effect.succeed(makeSummary(input));
    });

  const stack: PullRequestService.PullRequestService["Service"]["stack"] = (input, readOptions) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.includeDetails, false);
      yield* Ref.update(stackCalls, (calls) => [...calls, input]);
      return yield* options.stack?.(input) ?? Effect.succeed(null);
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type === "thread.pull-request-link.sync") {
      return Ref.update(syncCommands, (recorded) => [...recorded, command]).pipe(
        Effect.andThen(options.onSync?.(command) ?? Effect.void),
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    if (command.type === "thread.pull-request.link") {
      return Ref.update(linkCommands, (recorded) => [...recorded, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    return Effect.die(new Error(`Unexpected command: ${command.type}`));
  };

  const layerDependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      withSharedProjectReads: (effect) => effect,
      summary,
      stack,
      invalidate: options.invalidate ?? (() => Effect.void),
      subscribeStateChanges: Effect.succeed(Stream.fromQueue(stateChanges)),
    }),
    Layer.mock(GitManager.GitManager)({
      subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithPullRequests: (threadId) =>
        Queue.offer(snapshotReads, undefined).pipe(
          Effect.andThen(Ref.get(snapshots)),
          Effect.map((snapshot) =>
            snapshot.threads
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.archivedAt === null &&
                  thread.pullRequests.length > 0,
              )
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: thread.id,
                },
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt === null ? null : DateTime.makeUnsafe(thread.settledAt),
                pullRequests: thread.pullRequests,
              })),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotReads, (count) => count + 1).pipe(
          Effect.andThen(Effect.die(new Error("pull request sync must not read the shell"))),
        ),
      dispatch,
      streamDomainEvents: Stream.fromQueue(domainEvents),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
  );

  return {
    activation,
    snapshots,
    snapshotReads,
    shellSnapshotReads,
    syncCommands,
    linkCommands,
    summaryCalls,
    stackCalls,
    domainEvents,
    stateChanges,
    layer: PullRequestSyncReactor.layer.pipe(Layer.provide(layerDependencies)),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const startAndSweep = Effect.fn("startPullRequestSyncHarness")(function* (fixture: Harness) {
  const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  return reactor;
});

const sweepAgain = Effect.fn("sweepPullRequestSyncHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
) {
  yield* TestClock.adjust("1 minute");
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
});

function runUpdated(
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}:1`);
  const at = DateTime.makeUnsafe(NOW);
  return {
    type: "run.updated",
    id: EventId.make(`event:${threadId}:${status}`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${threadId}:1`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function commandRan(
  threadId: ThreadId,
  input: string,
  output?: string,
  name = "command",
): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}:1`);
  const at = DateTime.makeUnsafe(NOW);
  return {
    type: "turn-item.updated",
    id: EventId.make(`event:${threadId}:${name}`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${threadId}:${name}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "command_execution",
      input,
      ...(output === undefined ? {} : { output }),
    },
  };
}

function applySync(
  snapshot: TestShellSnapshot,
  commands: ReadonlyArray<SyncCommand>,
): TestShellSnapshot {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      pullRequests: thread.pullRequests.map((link) => {
        const command = commands.findLast(
          (candidate) => candidate.threadId === thread.id && candidate.number === link.number,
        );
        return command === undefined
          ? link
          : { ...link, snapshot: command.snapshot, stack: command.stack };
      }),
    })),
  };
}

const stackLayer = (number: number) => ({
  number,
  headBranch: `layer-${number}`,
  state: "open" as const,
});

/**
 * Stack 80 starts as #18 and #20; `grow` pushes #83 on top. `cachedRead` behaves like
 * `PullRequestReadCache`: a read is kept for 60 s and invalidating the reference drops it.
 */
function makeGrowingStack() {
  let layers = [stackLayer(18), stackLayer(20)];
  const entries = new Map<number, { readonly layers: typeof layers; expiresAt: number }>();
  const invalidated: Array<number> = [];
  const stackOf = (stackLayers: typeof layers): PullRequestStack => ({
    id: "stack-80",
    number: 80,
    url: "https://github.com/owner/repository/stack/80",
    base: "main",
    layers: stackLayers,
  });
  return {
    invalidated,
    grow: () => {
      layers = [...layers, stackLayer(83)];
    },
    read: () => Effect.sync(() => stackOf(layers)),
    invalidate: (({ reference }) =>
      Effect.sync(() => {
        invalidated.push(reference?.number ?? -1);
        entries.delete(reference?.number ?? -1);
      })) satisfies PullRequestService.PullRequestService["Service"]["invalidate"],
    cachedRead: (input: PullRequestRef) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          let entry = entries.get(input.number);
          if (entry === undefined || entry.expiresAt <= now) {
            entry = { layers, expiresAt: now + 60_000 };
            entries.set(input.number, entry);
          }
          return stackOf(entry.layers);
        }),
      ),
  };
}

const applyRecordedSyncs = (fixture: Harness) =>
  Ref.get(fixture.syncCommands).pipe(
    Effect.flatMap((commands) =>
      Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands)),
    ),
  );

const linkPullRequest83 = (fixture: Harness) =>
  Ref.update(fixture.snapshots, (snapshot) => ({
    ...snapshot,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      pullRequests: [...thread.pullRequests, makeLink(83)],
    })),
  }));

const storedStackLayers = (fixture: Harness) =>
  Ref.get(fixture.snapshots).pipe(
    Effect.map((snapshot) =>
      snapshot.threads[0]!.pullRequests.map((link) => [
        link.number,
        link.stack?.layers.map((layer) => layer.number),
      ]),
    ),
  );

const requestAndApply = Effect.fn("requestPullRequestSyncHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  number: number,
) {
  yield* reactor.requestSync({ host: "github.com", repository: "owner/repository", number });
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  yield* applyRecordedSyncs(fixture);
});

/** A thread with an open pull request whose merge command marks the end of earlier events. */
const MERGING_THREAD = ThreadId.make("merging");

/** The link commands `events` dispatch, read once the reactor has handled them all. */
const linksFrom = Effect.fn("linksFrom")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  yield* Ref.set(fixture.linkCommands, []);
  yield* Queue.offerAll(fixture.domainEvents, [
    ...events,
    commandRan(MERGING_THREAD, "gh pr merge 7", undefined, "merge"),
  ]);
  yield* Queue.take(fixture.snapshotReads);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  return yield* Ref.get(fixture.linkCommands);
});

const mergingSnapshot = () =>
  makeSnapshot([makeThread(MERGING_THREAD, { pullRequests: [makeLink(7, { state: "open" })] })]);



describe("PullRequestSyncReactor", () => {
  it.effect("links a created pull request once its command settles, with one command id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({ snapshot: mergingSnapshot() });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const settled = commandRan(
            ThreadId.make("agent"),
            "gh pr create --fill",
            "https://github.com/owner/repository/pull/124",
          );
          assert.strictEqual(settled.type, "turn-item.updated");
          if (settled.type !== "turn-item.updated") return;

          const links = yield* linksFrom(fixture, reactor, [
            { ...settled, payload: { ...settled.payload, status: "running" } },
            settled,
            settled,
          ]);

          assert.deepStrictEqual(
            links.map((command) => command.number),
            [124, 124],
          );
          assert.strictEqual(links[0]!.commandId, links[1]!.commandId);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

