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
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
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

/** The shell the fake projection store serves: one project and its threads. */
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
    provider: "github",
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

  const dependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      summary,
      stack,
      invalidate: options.invalidate ?? (() => Effect.void),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      // Mirrors the store's filter: active threads that have at least one link.
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
    layer: PullRequestSyncReactor.layer.pipe(Layer.provide(dependencies)),
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

/** What the reactor would have persisted, so the next sweep sees its own writes. */
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
          // Reads only linked threads, never the full shell snapshot of every thread.
          assert.strictEqual(yield* Ref.get(fixture.shellSnapshotReads), 0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("asks the host once for a pull request shared by two threads", () =>
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
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          const firstSweep = yield* Ref.get(fixture.syncCommands);
          assert.strictEqual(firstSweep.length, 1);
          yield* Ref.update(fixture.snapshots, (snapshot) => applySync(snapshot, firstSweep));

          yield* sweepAgain(fixture, reactor);

          // Still open on an active thread, so the host was asked again, but nothing changed.
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.stackCalls)).length, 1);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("refreshes closed links through the reactor's project after reopening elsewhere", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stale = yield* Ref.make(true);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("first", { pullRequests: [makeLink(42, { state: "closed" })] }),
            makeThread("second", {
              projectId: ProjectId.make("second-project"),
              pullRequests: [makeLink(42, { state: "closed" })],
            }),
          ]),
          invalidate: ({ reference }) =>
            reference?.projectId === makeProject().id && reference.host === "github.com"
              ? Ref.set(stale, false)
              : Effect.void,
          summary: (input) =>
            Ref.get(stale).pipe(
              Effect.map((cached) => makeSummary(input, { state: cached ? "closed" : "open" })),
            ),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 42,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
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
            makeThread("merged", { pullRequests: [makeLink(1, { state: "merged" })] }),
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

  it.effect("discovers externally reopened pull requests after fifteen minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"closed" | "open">("closed");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("closed", { pullRequests: [makeLink(2, { state: "closed" })] }),
          ]),
          summary: (input) =>
            Ref.get(state).pipe(Effect.map((state) => makeSummary(input, { state }))),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* Ref.set(state, "open");
          for (let index = 0; index < 14; index += 1) yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).at(-1)?.snapshot.state, "open");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
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
          // One sweep for the first link and one for the three that arrived while it read.
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

  it.effect("polls open pull requests on settled threads every fifteen minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("settled", {
              settledOverride: "settled",
              settledAt: "2026-08-21T00:00:00.000Z",
              pullRequests: [makeLink(5, { state: "open" })],
            }),
          ]),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

          for (let index = 0; index < 13; index += 1) yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);

          yield* sweepAgain(fixture, reactor);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("auto-links missing native stack layers and leaves dismissed ones alone", () =>
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
          ]),
          stack: () => Effect.succeed(stack),
        });

        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);

          const syncCommands = yield* Ref.get(fixture.syncCommands);
          assert.deepStrictEqual(
            syncCommands.map((command) => [command.number, command.stack] as const),
            [[42, { kind: "native", ...stack }]],
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

  it.effect("leaves a rate limited host unread until its pause ends", () => {
    const skips: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const parts = Array.isArray(message) ? message : [message];
      if (logLevel === "Warn" && parts[0] === "pull request sync skipped") skips.push(parts);
    });
    const retryAt = Date.parse(NOW) + 3 * 60_000;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("first", { pullRequests: [makeLink(7, { state: "open" })] }),
            makeThread("second", { pullRequests: [makeLink(8, { state: "open" })] }),
            makeThread("third", {
              pullRequests: [
                makeLink(
                  9,
                  { state: "open" },
                  { host: "forge.example", url: "https://forge.example/owner/repository/pulls/9" },
                ),
              ],
            }),
          ]),
          summary: (input) =>
            Effect.gen(function* () {
              if (input.host === "github.com" && (yield* Clock.currentTimeMillis) < retryAt) {
                const paused = new PullRequestProviderError({
                  provider: "github",
                  operation: "getChangeRequestSummary",
                  reason: "rate-limited",
                  detail: "paused",
                  retryAt,
                });
                return yield* new PullRequestOperationError({
                  operation: "summary",
                  detail: "paused",
                  cause: paused,
                });
              }
              return makeSummary(input, { state: "open" });
            }),
        });
        const githubReads = Ref.get(fixture.summaryCalls).pipe(
          Effect.map((calls) =>
            calls.filter((call) => call.host === "github.com").map((call) => call.number),
          ),
        );

        yield* Effect.gen(function* () {
          // The first refused read pauses the host, so the sweep does not try the other.
          const reactor = yield* startAndSweep(fixture);
          assert.deepStrictEqual(yield* githubReads, [7]);
          assert.strictEqual(skips.length, 1);
          assert.deepInclude(skips[0]![1], { count: 1 });

          // A requested refresh waits for the pause like the sweep does.
          yield* reactor.requestSync({
            host: "github.com",
            repository: "owner/repository",
            number: 7,
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          yield* sweepAgain(fixture, reactor);
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* githubReads, [7]);
          assert.strictEqual(skips.length, 1);
          // Other hosts keep their cadence.
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 4);

          yield* sweepAgain(fixture, reactor);
          assert.sameMembers((yield* githubReads).slice(1), [7, 8]);
        }).pipe(
          // The reactor forks its worker while its layer builds, so the logger must reach it there.
          Effect.provide(
            fixture.layer.pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
          ),
        );
      }),
    );
  });

  it.effect("pauses the host when only its stack read is rate limited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const retryAt = Date.parse(NOW) + 3 * 60_000;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("one", { pullRequests: [makeLink(7, null)] })]),
          summary: (input) => Effect.succeed(makeSummary(input, { state: "open" })),
          stack: () =>
            Effect.gen(function* () {
              if ((yield* Clock.currentTimeMillis) >= retryAt) return null;
              return yield* new PullRequestOperationError({
                operation: "stack",
                detail: "paused",
                cause: new PullRequestProviderError({
                  provider: "github",
                  operation: "getChangeRequestStack",
                  reason: "rate-limited",
                  detail: "paused",
                  retryAt,
                }),
              });
            }),
        });
        const reads = Effect.all([
          Ref.get(fixture.summaryCalls).pipe(Effect.map((calls) => calls.length)),
          Ref.get(fixture.stackCalls).pipe(Effect.map((calls) => calls.length)),
        ]);

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          assert.deepStrictEqual(yield* reads, [1, 1]);
          yield* sweepAgain(fixture, reactor);
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* reads, [1, 1]);

          // At retryAt the pull request is read again, stack included.
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* reads, [2, 2]);
          assert.strictEqual((yield* Ref.get(fixture.syncCommands)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reads open links fresh only when a run that ran a merge command ends", () =>
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
          // The agent merges from a shell during its turn, inside the summary cache window.
          yield* Ref.set(state, "merged");
          yield* Ref.set(fixture.summaryCalls, []);

          yield* Queue.offerAll(fixture.domainEvents, [
            // A run that only reads its pull request costs no host read when it ends.
            commandRan(ThreadId.make("other"), "gh pr view 9"),
            runUpdated(ThreadId.make("other"), "completed"),
            commandRan(ThreadId.make("agent"), "gh pr merge 7 --squash 2>&1 | tail -3"),
            runUpdated(ThreadId.make("agent"), "completed"),
          ]);
          // The agent thread's lookup, then the requested sweep.
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
