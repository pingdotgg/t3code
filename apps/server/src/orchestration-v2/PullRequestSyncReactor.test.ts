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
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

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
    Layer.succeed(Crypto.Crypto, testCrypto),
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

function commandRan(threadId: ThreadId, input: string): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}:1`);
  const at = DateTime.makeUnsafe(NOW);
  return {
    type: "turn-item.updated",
    id: EventId.make(`event:${threadId}:command`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${threadId}:command`),
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

describe("PullRequestSyncReactor", () => {
  it.effect("retries a failed stack read after the summary becomes terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        let attempts = 0;
        const nativeStack: PullRequestStack = {
          id: "stack",
          number: 7,
          url: "https://github.com/owner/repository/stacks/7",
          base: "main",
          layers: [{ number: 7, headBranch: "feature", state: "merged" }],
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7)] })]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { state: "merged", mergedAt: NOW })),
          stack: () =>
            ++attempts === 1
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "stack",
                    detail: "temporary failure",
                  }),
                )
              : Effect.succeed(nativeStack),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const commands = yield* Ref.get(fixture.syncCommands);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands));
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual(attempts, 2);
          assert.deepStrictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.stack, {
            kind: "native",
            ...nativeStack,
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("explicit refresh reads a changed stack even when its PR summary is unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7, {})] })]),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 0);
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 7,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
  it.effect("snapshots an unsynced link once and writes it to the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(42)] })]),
          summary: (input) =>
            Effect.succeed(makeSummary(input, { title: "Ship it", isDraft: true })),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            {
              projectId: PROJECT_ID,
              host: "github.com",
              repository: "owner/repository",
              number: 42,
            },
          ]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map(({ commandId: _, ...rest }) => rest),
            [
              {
                type: "thread.pull-request-link.sync",
                threadId: ThreadId.make("one"),
                host: "github.com",
                repository: "owner/repository",
                number: 42,
                snapshot: {
                  state: "open",
                  title: "Ship it",
                  headBranch: "feature",
                  baseBranch: "main",
                  isDraft: true,
                  updatedAt: "2026-08-27T00:00:00.000Z",
                  syncedAt: NOW,
                  closedAt: null,
                  mergedAt: null,
                },
                stack: null,
              },
            ],
          );
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
          assert.strictEqual(yield* Ref.get(fixture.shellSnapshotReads), 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("asks the host once for a pull request shared by two threads in one project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", { pullRequests: [makeLink(42)] }),
            makeThread("two", {
              pullRequests: [makeLink(42, null, { repository: "Owner/Repository" })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
          const commands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(
            commands
              .map((command) => [command.threadId, command.repository] as const)
              .sort((left, right) => left[0].localeCompare(right[0])),
            [
              [ThreadId.make("one"), "owner/repository"],
              [ThreadId.make("two"), "Owner/Repository"],
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["summary", "stack"] as const)(
    "isolates a failed project %s refresh and retries it after the other project succeeds",
    (operation) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const otherProject = ProjectId.make("other-project");
          const link = makeLink(42, { state: "merged", mergedAt: NOW });
          let failing = true;
          const failure = new PullRequestOperationError({ operation, detail: "checkout missing" });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("failing", { pullRequests: [link] }),
              makeThread("healthy", { projectId: otherProject, pullRequests: [link] }),
              makeThread("same-project", { projectId: otherProject, pullRequests: [link] }),
            ]),
            summary: (input) =>
              failing && input.projectId === PROJECT_ID && operation === "summary"
                ? Effect.fail(failure)
                : Effect.succeed(
                    makeSummary(input, {
                      state: "merged",
                      mergedAt: NOW,
                      title: input.projectId,
                    }),
                  ),
            stack: (input) =>
              failing && input.projectId === PROJECT_ID && operation === "stack"
                ? Effect.fail(failure)
                : Effect.succeed({
                    id: input.projectId,
                    number: 42,
                    url: "https://github.com/owner/repository/stacks/42",
                    base: "main",
                    layers: [{ number: 42, headBranch: "feature", state: "merged" }],
                  }),
          });
          yield* Effect.gen(function* () {
            const reactor = yield* startAndSweep(fixture);
            assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
            yield* reactor.requestSync(link);
            yield* Queue.take(fixture.snapshotReads);
            yield* reactor.drain;
            const commands = yield* Ref.get(fixture.syncCommands);
            assert.sameDeepMembers(
              commands.map((command) => [
                command.threadId,
                command.snapshot.title,
                command.stack?.id,
              ]),
              [
                ["healthy", otherProject, otherProject],
                ["same-project", otherProject, otherProject],
              ],
            );
            assert.sameMembers(
              (yield* Ref.get(fixture.summaryCalls)).map((call) => call.projectId),
              [PROJECT_ID, otherProject],
            );
            assert.sameMembers(
              (yield* Ref.get(fixture.stackCalls)).map((call) => call.projectId),
              operation === "stack" ? [PROJECT_ID, otherProject] : [otherProject],
            );
            yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands));
            failing = false;
            yield* sweepAgain(fixture, reactor);
            assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 3);
            assert.strictEqual(
              (yield* Ref.get(fixture.summaryCalls)).at(-1)?.projectId,
              PROJECT_ID,
            );
            const retried = (yield* Ref.get(fixture.syncCommands)).at(-1);
            assert.strictEqual(retried?.threadId, ThreadId.make("failing"));
            assert.strictEqual(retried?.snapshot.title, PROJECT_ID);
            assert.strictEqual(retried?.stack?.id, PROJECT_ID);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("recovers the HTTP port when syncing an older Forgejo link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", {
              pullRequests: [
                makeLink(42, null, {
                  host: "forge.example",
                  url: "http://forge.example:3000/owner/repository/pulls/42",
                }),
              ],
            }),
          ]),
          summary: (input) => Effect.succeed(makeSummary(input)),
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls))[0]?.host, "forge.example:3000");
          assert.strictEqual((yield* Ref.get(fixture.syncCommands))[0]?.host, "forge.example:3000");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("dispatches nothing when the host snapshot is unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(42)] })]),
          summary: (input) => Effect.succeed(makeSummary(input, { updatedAt: NOW })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const firstSweep = yield* Ref.get(fixture.syncCommands);
          assert.strictEqual(firstSweep.length, 1);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, firstSweep));

          yield* sweepAgain(fixture, reactor);

          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each(["mergeable", "conflicting"] as const)(
    "keeps a known %s snapshot when a refresh reads mergeability as unknown",
    (mergeability) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const answers = ["unknown", mergeability] as const;
          const reads = yield* Ref.make(0);
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("one", {
                pullRequests: [makeLink(42, { updatedAt: NOW, mergeability })],
              }),
            ]),
            summary: (input) =>
              Ref.getAndUpdate(reads, (count) => count + 1).pipe(
                Effect.map((count) =>
                  makeSummary(input, {
                    updatedAt: NOW,
                    mergeability: count === 0 ? mergeability : answers[count - 1],
                  }),
                ),
              ),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* startAndSweep(fixture);
            yield* requestAndApply(fixture, reactor, 42);
            yield* requestAndApply(fixture, reactor, 42);

            assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 3);
            assert.deepStrictEqual(
              (yield* Ref.get(fixture.syncCommands)).map(
                (command) => command.snapshot.mergeability,
              ),
              [],
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("persists other changes read with unknown mergeability under the known one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", {
              pullRequests: [makeLink(42, { updatedAt: NOW, mergeability: "conflicting" })],
            }),
          ]),
          summary: (input) =>
            Effect.succeed(
              makeSummary(input, { updatedAt: NOW, title: "Renamed", mergeability: "unknown" }),
            ),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map(({ snapshot }) => [
              snapshot.title,
              snapshot.mergeability,
            ]),
            [["Renamed", "conflicting"]],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("refreshes closed links through each project after reopening elsewhere", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const invalidated = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("first", { pullRequests: [makeLink(42, { state: "closed" })] }),
            makeThread("second", {
              projectId: ProjectId.make("second-project"),
              pullRequests: [makeLink(42, { state: "closed" })],
            }),
          ]),
          invalidate: ({ reference }) =>
            reference !== undefined
              ? Ref.update(invalidated, (projects) => [...projects, reference.projectId])
              : Effect.void,
          summary: (input) =>
            Ref.get(invalidated).pipe(
              Effect.map((projects) =>
                makeSummary(input, {
                  state: projects.includes(input.projectId) ? "open" : "closed",
                }),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 42,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.sameMembers(
            [...(yield* Ref.get(invalidated))],
            [PROJECT_ID, ProjectId.make("second-project")],
          );
          assert.sameMembers(
            (yield* Ref.get(fixture.stackCalls)).map((call) => call.projectId),
            [PROJECT_ID, ProjectId.make("second-project")],
          );
          const commands = yield* Ref.get(fixture.syncCommands);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, commands));
          const snapshot = yield* Ref.get(fixture.snapshots);
          assert.deepStrictEqual(
            snapshot.threads.map((thread) => thread.pullRequests[0]?.snapshot?.state),
            ["open", "open"],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("stops asking the host once a pull request is merged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged", {
              pullRequests: [
                makeLink(1, { state: "merged", mergedAt: "2026-08-27T00:00:00.000Z" }),
              ],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);

          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.syncCommands), []);

          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 1,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((call) => call.number),
            [1],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("re-reads a merged pull request until the host supplies its merge time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const invalidated = yield* Ref.make<ReadonlyArray<number>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged", { pullRequests: [makeLink(1, { state: "merged" })] }),
          ]),
          invalidate: ({ reference }) =>
            Ref.update(invalidated, (numbers) => [...numbers, reference?.number ?? -1]),
          summary: (input) =>
            Effect.succeed(
              makeSummary(input, { state: "merged", mergedAt: "2026-08-27T00:00:00.000Z" }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const firstSweep = yield* Ref.get(fixture.syncCommands);
          // The held merged summary is dropped so the read reaches the host.
          assert.deepStrictEqual(yield* Ref.get(invalidated), [1]);
          assert.strictEqual(firstSweep.at(-1)?.snapshot.mergedAt, "2026-08-27T00:00:00.000Z");
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, firstSweep));

          for (let index = 0; index < 15; index += 1) yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("syncs a pull request a reader saw merge without waiting for the sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<PullRequestSummary["state"]>("open");
        const invalidated = yield* Ref.make<ReadonlyArray<number>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("agent", { pullRequests: [makeLink(7, { state: "open" })] }),
          ]),
          summary: (input) =>
            Ref.get(state).pipe(
              Effect.map((current) =>
                makeSummary(input, current === "merged" ? { state: current, mergedAt: NOW } : {}),
              ),
            ),
          invalidate: ({ reference }) =>
            Ref.update(invalidated, (numbers) => [...numbers, reference?.number ?? -1]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(state, "merged");

          yield* Queue.offer(fixture.stateChanges, {
            host: "github.com",
            repository: "owner/repository",
            number: 7,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(yield* Ref.get(invalidated), [7]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.snapshot.state),
            ["merged"],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each([true, false])(
    "syncs linked draft status %s as soon as a reader reports a change",
    (isDraft) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const draft = yield* Ref.make(!isDraft);
        const invalidated = yield* Ref.make<ReadonlyArray<number>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("agent", { pullRequests: [makeLink(7, { isDraft: !isDraft })] }),
          ]),
          summary: (input) =>
            Ref.get(draft).pipe(Effect.map((isDraft) => makeSummary(input, { isDraft }))),
          invalidate: ({ reference }) =>
            Ref.update(invalidated, (numbers) => [...numbers, reference?.number ?? -1]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(draft, isDraft);
          yield* Queue.offer(fixture.stateChanges, {
            host: "github.com",
            repository: "owner/repository",
            number: 7,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(yield* Ref.get(invalidated), [7]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.snapshot.isDraft),
            [isDraft],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("preserves a refresh requested while an older host read is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          summary: (input) =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) {
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(release);
              }
              return makeSummary(input, { state: calls === 1 ? "closed" : "open" });
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([
              makeThread("closed", { pullRequests: [makeLink(2, { state: "closed" })] }),
            ]),
          );
          const key = { host: "github.com", repository: "owner/repository", number: 2 };
          yield* reactor.requestSync(key);
          yield* Deferred.await(reading);
          yield* reactor.requestSync(key);
          yield* Deferred.succeed(release, undefined);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.snapshot.state, "open");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reads a burst of requested links in one sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          summary: (input) =>
            Effect.gen(function* () {
              if (input.number === 1) {
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(release);
              }
              return makeSummary(input);
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot(
              [1, 2, 3, 4].map((number) =>
                makeThread(`thread-${number}`, { pullRequests: [makeLink(number)] }),
              ),
            ),
          );
          const request = (number: number) =>
            reactor.requestSync({ host: "github.com", repository: "owner/repository", number });
          yield* request(1);
          yield* Deferred.await(reading);
          yield* Effect.forEach([2, 3, 4], request, { discard: true });
          yield* Deferred.succeed(release, undefined);
          yield* reactor.drain;
          assert.strictEqual(yield* Queue.size(fixture.snapshotReads), 2);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((ref) => ref.number).toSorted(),
            [1, 2, 3, 4],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the stack read for a pull request the summary places in no stack", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("unstacked", { pullRequests: [makeLink(1)] }),
            makeThread("stacked", { pullRequests: [makeLink(2)] }),
            makeThread("unknown", { pullRequests: [makeLink(3)] }),
          ]),
          summary: (input) =>
            Effect.succeed(
              makeSummary(
                input,
                input.number === 1
                  ? { stack: null }
                  : input.number === 2
                    ? { stack: { number: 9, position: 1, size: 2, base: "main" } }
                    : {},
              ),
            ),
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.stackCalls)).map((ref) => ref.number).toSorted(),
            [2, 3],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.number).toSorted(),
            [1, 2, 3],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("leaves a settled thread's links unread until the thread is unsettled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("settled", {
              settledOverride: "settled",
              settledAt: "2026-08-21T00:00:00.000Z",
              pullRequests: [makeLink(5, { state: "open" }), makeLink(6, { state: "closed" })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          for (let index = 0; index < 15; index += 1) yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), []);

          yield* Ref.update(fixture.snapshots, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) => ({
              ...thread,
              settledOverride: null,
              settledAt: null,
            })),
          }));
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((call) => call.number).toSorted(),
            [5, 6],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("auto-links missing native stack layers on active threads only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stack: PullRequestStack = {
          id: "stack-1",
          number: 42,
          url: "https://github.com/owner/repository/stack/1",
          base: "main",
          layers: [
            { number: 41, headBranch: "layer-1", state: "merged" },
            { number: 42, headBranch: "layer-2", state: "open" },
            { number: 43, headBranch: "layer-3", state: "open" },
          ],
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", {
              pullRequests: [
                makeLink(42),
                makeLink(41, { state: "merged" }, { source: "stack-dismissed" }),
              ],
            }),
            makeThread("settled", {
              settledOverride: "settled",
              settledAt: "2026-08-21T00:00:00.000Z",
              pullRequests: [makeLink(42)],
            }),
          ]),
          stack: () => Effect.succeed(stack),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          const syncCommands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(
            syncCommands.map((command) => [command.threadId, command.stack] as const),
            [
              [ThreadId.make("one"), { kind: "native", ...stack }],
              [ThreadId.make("settled"), { kind: "native", ...stack }],
            ],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.linkCommands)).map(({ commandId: _, ...rest }) => rest),
            [
              {
                type: "thread.pull-request.link",
                threadId: ThreadId.make("one"),
                host: "github.com",
                repository: "owner/repository",
                number: 43,
                url: "https://github.com/owner/repository/pull/43",
                source: "stack",
              },
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("re-reads every member's layers once a new layer joins the stack", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stack = makeGrowingStack();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("one", { pullRequests: [makeLink(18), makeLink(20)] }),
          ]),
          stack: stack.read,
        });
        const sweepAndApply = (reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"]) =>
          sweepAgain(fixture, reactor).pipe(Effect.andThen(applyRecordedSyncs(fixture)));

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* applyRecordedSyncs(fixture);
          assert.deepStrictEqual(yield* storedStackLayers(fixture), [
            [18, [18, 20]],
            [20, [18, 20]],
          ]);
          const readsBeforeGrowth = (yield* Ref.get(fixture.stackCalls)).length;

          // #83 is pushed on top and linked; only its own link starts without a snapshot.
          stack.grow();
          yield* linkPullRequest83(fixture);
          yield* sweepAndApply(reactor);
          yield* sweepAndApply(reactor);

          assert.deepStrictEqual(yield* storedStackLayers(fixture), [
            [18, [18, 20, 83]],
            [20, [18, 20, 83]],
            [83, [18, 20, 83]],
          ]);
          const readsAfterGrowth = (yield* Ref.get(fixture.stackCalls)).slice(readsBeforeGrowth);
          assert.deepStrictEqual(
            readsAfterGrowth.map((ref) => ref.number).toSorted(),
            [18, 20, 83],
          );

          // Every member agrees now, so a further sweep reads no stack.
          yield* sweepAndApply(reactor);
          assert.strictEqual(
            (yield* Ref.get(fixture.stackCalls)).length,
            readsBeforeGrowth + readsAfterGrowth.length,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reads past the cache when a sibling flags a member during its summary read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stack = makeGrowingStack();
        const synced83 = yield* Deferred.make<void>();
        let holdSummary = false;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(18)] })]),
          invalidate: stack.invalidate,
          stack: stack.cachedRead,
          // #18's summary stays in flight until #83 has read its stack, flagged #18 and synced.
          summary: (input) =>
            (holdSummary && input.number === 18 ? Deferred.await(synced83) : Effect.void).pipe(
              Effect.as(makeSummary(input, { updatedAt: NOW })),
            ),
          onSync: (command) =>
            command.number === 83 ? Deferred.succeed(synced83, undefined) : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* applyRecordedSyncs(fixture);

          // 30 s later a state change refreshes #18, which caches its two-layer read until 90 s.
          yield* TestClock.adjust("30 seconds");
          yield* requestAndApply(fixture, reactor, 18);

          // #83 is pushed on top and linked as the scheduled sweep at 60 s starts, so that sweep
          // reads #83 for the first time while #18's summary is still in flight.
          stack.grow();
          yield* linkPullRequest83(fixture);
          holdSummary = true;
          const invalidatedBefore = stack.invalidated.length;
          yield* TestClock.adjust("30 seconds");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          yield* applyRecordedSyncs(fixture);

          assert.deepStrictEqual(yield* storedStackLayers(fixture), [
            [18, [18, 20, 83]],
            [83, [18, 20, 83]],
          ]);
          assert.deepStrictEqual(stack.invalidated.slice(invalidatedBefore), [18]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("leaves stacks in other repositories alone when their ids match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        // Without a host id the GitHub decoder falls back to the stack number, so two
        // repositories can both report stack "3".
        const otherLink = makeLink(7, null, {
          repository: "owner/other",
          url: "https://github.com/owner/other/pull/7",
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(1), otherLink] })]),
          stack: (input) =>
            Effect.succeed({
              id: "3",
              number: 3,
              url: `https://github.com/${input.repository}/stack/3`,
              base: "main",
              layers: [
                { number: input.number, headBranch: "layer-1", state: "open" },
                { number: input.number + 1, headBranch: "layer-2", state: "open" },
              ],
            }),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* applyRecordedSyncs(fixture);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 2);

          yield* sweepAgain(fixture, reactor);
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps existing snapshots and continues when the host fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("failing", { pullRequests: [makeLink(7, { state: "open" })] }),
            makeThread("fine", { pullRequests: [makeLink(8)] }),
          ]),
          summary: (input) =>
            input.number === 7
              ? Effect.fail(
                  new PullRequestOperationError({ operation: "summary", detail: "host down" }),
                )
              : Effect.succeed(makeSummary(input)),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => command.number),
            [8],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect.each([
    "gh pr merge 7 --squash 2>&1 | tail -3",
    "cafe pr merge 7 --squash",
    "az repos pr update --id 7 --status completed",
  ])("reads open links fresh only when a run that ran `%s` ends", (mergeCommand) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<PullRequestSummary["state"]>("open");
        const invalidated = yield* Ref.make<ReadonlyArray<number>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("agent", { pullRequests: [makeLink(7, { state: "open" })] }),
            makeThread("other", { pullRequests: [makeLink(9, { state: "open" })] }),
          ]),
          summary: (input) =>
            Ref.get(state).pipe(
              Effect.map((current) =>
                makeSummary(input, current === "merged" ? { state: current, mergedAt: NOW } : {}),
              ),
            ),
          invalidate: ({ reference }) =>
            Ref.update(invalidated, (numbers) => [...numbers, reference?.number ?? -1]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* Ref.set(state, "merged");
          yield* Ref.set(fixture.summaryCalls, []);

          yield* Queue.offerAll(fixture.domainEvents, [
            commandRan(ThreadId.make("other"), "gh pr view 9"),
            runUpdated(ThreadId.make("other"), "completed"),
            commandRan(ThreadId.make("agent"), mergeCommand),
            runUpdated(ThreadId.make("agent"), "completed"),
          ]);
          yield* Queue.take(fixture.snapshotReads);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(yield* Ref.get(invalidated), [7]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((call) => call.number),
            [7],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.syncCommands)).map((command) => [
              command.number,
              command.snapshot.state,
            ]),
            [[7, "merged"]],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
