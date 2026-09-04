import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
} from "./provider/Errors.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-08-20T12:00:00.000Z";

const makeThread = (
  id: string,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null = null,
  archivedAt: string | null = null,
  deletedAt: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    status,
    providerName: "codex" as const,
    providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId,
    lastError: null,
    updatedAt,
  },
});

const makeProviderService = (liveThreadIds: ReadonlyArray<ThreadId> = []) =>
  ({
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    compactThread: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
    getCapabilities: () => Effect.die("unused"),
    assertConversationRollbackSupported: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    uploadFeedback: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderService.ProviderService["Service"];

const queryWithThreads = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  ({
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.succeed({ threads } as never),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>;
  readonly continueAfterRestart?: boolean;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
  readonly providerService?: ProviderService.ProviderService["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly dispatch: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
}) =>
  ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads(input.threads),
    ),
    Effect.provideService(
      ProviderService.ProviderService,
      input.providerService ?? makeProviderService(input.liveThreadIds),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: input.dispatch,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          continueThreadsAfterServerUpdate: input.continueAfterRestart ?? false,
        }),
        NodeServices.layer,
      ),
    ),
  );

it.effect("marks active running sessions that have persisted resume state", () => {
  const active = makeThread("thread-mark-active", "running", TurnId.make("turn-mark-active"));
  const archived = makeThread(
    "thread-mark-archived",
    "running",
    TurnId.make("turn-mark-archived"),
    updatedAt,
  );
  const ready = makeThread("thread-mark-ready", "ready");
  const missingResumeState = makeThread(
    "thread-mark-missing-resume-state",
    "running",
    TurnId.make("turn-mark-missing-resume-state"),
  );
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return ServerRuntimeStartup.markRunningProviderSessionsForContinuation.pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      queryWithThreads([active, archived, ready, missingResumeState]),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: (threadId) =>
        Effect.sync(() => bindingReads.push(threadId)).pipe(
          Effect.as(
            Option.some({
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              ...(threadId === active.id ? { resumeCursor: { threadId } } : {}),
              runtimePayload: { activeTurnId: "turn-mark-active" },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    }),
    Effect.tap((marked) =>
      Effect.sync(() => {
        assert.deepStrictEqual(bindingReads, [active.id, missingResumeState.id]);
        assert.deepStrictEqual(marked, [active.id]);
        assert.deepStrictEqual(upserts[0]?.runtimePayload, {
          activeTurnId: "turn-mark-active",
          continueAfterServerUpdate: active.session.activeTurnId,
          continueAfterServerUpdatePrepared: null,
        });
      }),
    ),
  );
});

it.effect.each(["marked update", "opt-in restart"] as const)(
  "continues %s sessions after activation with provider-specific input",
  (recovery) =>
    Effect.gen(function* () {
      const codex = makeThread(
        "thread-continue-codex",
        "running",
        TurnId.make("turn-continue-codex"),
      );
      const fallbackContinuationTurnId = TurnId.make("turn-continue-fallback");
      const fallback = makeThread(
        "thread-continue-fallback",
        recovery === "marked update" ? "starting" : "running",
        recovery === "marked update" ? null : fallbackContinuationTurnId,
      );
      const fallbackProviderInstanceId = ProviderInstanceId.make("claudeAgent");
      const continuationSent = yield* Deferred.make<void>();
      const continuationCleared = yield* Deferred.make<void>();
      const sends: ProviderSendTurnInput[] = [];
      const dispatched: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBinding>(
        [codex, fallback].map((thread) => [
          thread.id,
          {
            threadId: thread.id,
            provider:
              thread.id === codex.id
                ? ProviderDriverKind.make("codex")
                : ProviderDriverKind.make("claudeAgent"),
            providerInstanceId:
              thread.id === codex.id ? providerInstanceId : fallbackProviderInstanceId,
            status: "running" as const,
            resumeCursor: { threadId: thread.id },
            runtimePayload:
              recovery === "marked update"
                ? {
                    continueAfterServerUpdate:
                      thread.id === codex.id
                        ? codex.session.activeTurnId
                        : fallbackContinuationTurnId,
                  }
                : { activeTurnId: thread.session.activeTurnId },
          },
        ]),
      );
      const providerService: ProviderService.ProviderService["Service"] = {
        ...makeProviderService(),
        getCapabilities: (instanceId) =>
          Effect.succeed({
            sessionModelSwitch: "in-session",
            ...(instanceId === providerInstanceId ? { promptlessTurnContinuation: true } : {}),
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            if (sends.length === 2) {
              yield* Deferred.succeed(continuationSent, undefined);
            }
            return {
              threadId: input.threadId,
              turnId: TurnId.make(`continued-${String(input.threadId)}`),
            };
          }),
      };

      yield* runReconciliation({
        threads: [codex, fallback],
        continueAfterRestart: recovery === "opt-in restart",
        providerService,
        directory: {
          getBinding: (threadId) =>
            Effect.sync(() => {
              const binding = bindings.get(threadId);
              return binding === undefined ? Option.none() : Option.some(binding);
            }),
          upsert: (binding) =>
            Effect.sync(() => {
              bindings.set(binding.threadId, binding);
              upserts.push(binding);
              const clearedCount = upserts.filter((candidate) => {
                const payload = candidate.runtimePayload;
                return (
                  payload !== null &&
                  typeof payload === "object" &&
                  !Array.isArray(payload) &&
                  "continueAfterServerUpdate" in payload &&
                  payload.continueAfterServerUpdate === null
                );
              }).length;
              return clearedCount === 1;
            }).pipe(
              Effect.flatMap((firstMarkerCleared) =>
                firstMarkerCleared ? Deferred.succeed(continuationCleared, undefined) : Effect.void,
              ),
            ),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        },
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command)).pipe(
            Effect.as({ sequence: dispatched.length }),
          ),
      });
      yield* Deferred.await(continuationSent);
      yield* Deferred.await(continuationCleared);

      assert.deepStrictEqual(
        sends.toSorted((left, right) =>
          String(left.threadId).localeCompare(String(right.threadId)),
        ),
        [
          { threadId: codex.id, continuation: true, interactionMode: "default" },
          {
            threadId: fallback.id,
            input: "Continue where you left off.",
            interactionMode: "default",
          },
        ],
      );
      assert.deepStrictEqual(
        dispatched.map((command) =>
          command.type === "thread.session.set"
            ? {
                threadId: command.threadId,
                status: command.session.status,
                activeTurnId: command.session.activeTurnId,
              }
            : null,
        ),
        [
          {
            threadId: codex.id,
            status: "starting",
            activeTurnId: null,
          },
          {
            threadId: fallback.id,
            status: "starting",
            activeTurnId: null,
          },
        ],
      );
      for (const [thread, continuationTurnId] of [
        [codex, codex.session.activeTurnId],
        [fallback, fallbackContinuationTurnId],
      ] as const) {
        assert.deepStrictEqual(
          upserts
            .filter((binding) => binding.threadId === thread.id)
            .map((binding) => binding.runtimePayload)[0],
          {
            continueAfterServerUpdate: continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
          },
        );
      }
      assert.equal(
        upserts.some((binding) => {
          const payload = binding.runtimePayload;
          return (
            payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "continueAfterServerUpdate" in payload &&
            payload.continueAfterServerUpdate === null
          );
        }),
        true,
      );
    }),
);

it.effect("does not continue archived or deleted marked sessions", () => {
  const archived = makeThread(
    "thread-continue-archived",
    "running",
    TurnId.make("turn-continue-archived"),
    updatedAt,
  );
  const deleted = makeThread(
    "thread-continue-deleted",
    "running",
    TurnId.make("turn-continue-deleted"),
    null,
    updatedAt,
  );
  const sends: ProviderSendTurnInput[] = [];
  const dispatched: OrchestrationCommand[] = [];

  return runReconciliation({
    threads: [archived, deleted],
    providerService: {
      ...makeProviderService(),
      sendTurn: (input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            threadId: input.threadId,
            turnId: TurnId.make("unexpected-archived-turn"),
          };
        }),
    },
    directory: {
      getBinding: (threadId) => {
        const thread = threadId === archived.id ? archived : deleted;
        return Effect.succeed(
          Option.some({
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { cursor: threadId },
            runtimePayload: {
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          }),
        );
      },
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepStrictEqual(sends, []);
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? { threadId: command.threadId, status: command.session.status }
              : null,
          ),
          [
            { threadId: archived.id, status: "error" },
            { threadId: deleted.id, status: "error" },
          ],
        );
      }),
    ),
  );
});

it.effect("retries continuation preparation before settling a persistent failure", () => {
  const thread = makeThread(
    "thread-continuation-preparation-failure",
    "running",
    TurnId.make("turn-continuation-preparation-failure"),
  );
  const dispatched: OrchestrationCommand[] = [];
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated continuation preparation failure",
  });

  return runReconciliation({
    threads: [thread],
    directory: {
      getBinding: () =>
        Effect.succeed(
          Option.some({
            threadId: thread.id,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId,
            status: "running" as const,
            resumeCursor: { cursor: thread.id },
            runtimePayload: {
              continueAfterServerUpdate: thread.session.activeTurnId,
            },
          }),
        ),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      dispatched.push(command);
      return command.session.status === "starting"
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: dispatched.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(
          dispatched.map(
            (command) => command.type === "thread.session.set" && command.session.status,
          ),
          ["starting", "starting", "error"],
        ),
      ),
    ),
  );
});

it.effect("reconciles multiple active and archived orphans but skips live sessions", () => {
  const starting = makeThread("thread-starting", "starting");
  const running = makeThread("thread-running", "running", TurnId.make("turn-running"));
  const staleActiveTurn = makeThread(
    "thread-stale-active-turn",
    "ready",
    TurnId.make("turn-stale-active"),
  );
  const archived = makeThread(
    "thread-archived",
    "running",
    TurnId.make("turn-archived"),
    updatedAt,
  );
  const live = makeThread("thread-live", "running", TurnId.make("turn-live"));
  const settled = makeThread("thread-ready", "ready");
  const dispatched: OrchestrationCommand[] = [];
  const bindingReads: ThreadId[] = [];
  const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];

  return runReconciliation({
    threads: [starting, running, staleActiveTurn, archived, live, settled],
    liveThreadIds: [live.id],
    directory: {
      getBinding: (candidate) =>
        Effect.sync(() => bindingReads.push(candidate)).pipe(
          Effect.as(
            Option.some({
              threadId: candidate,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: "running" as const,
              resumeCursor: { cursor: candidate },
              runtimePayload: {
                activeTurnId: "stale",
                unrelated: candidate,
                ...(candidate === staleActiveTurn.id
                  ? { continueAfterServerUpdate: "turn-from-an-earlier-update" }
                  : {}),
              },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) =>
      Effect.sync(() => dispatched.push(command)).pipe(Effect.as({ sequence: dispatched.length })),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const orphanIds = [starting.id, running.id, staleActiveTurn.id, archived.id];
        assert.deepStrictEqual(bindingReads, orphanIds);
        assert.deepStrictEqual(
          dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
          orphanIds,
        );
        assert.deepStrictEqual(
          dispatched.map((command) =>
            command.type === "thread.session.set"
              ? {
                  status: command.session.status,
                  activeTurnId: command.session.activeTurnId,
                }
              : null,
          ),
          orphanIds.map(() => ({ status: "error" as const, activeTurnId: null })),
        );
        assert.equal(upserts.length, orphanIds.length);
        for (const binding of upserts) {
          assert.equal(binding.status, "stopped");
          assert.deepStrictEqual(
            binding.runtimePayload,
            binding.threadId === staleActiveTurn.id
              ? {
                  activeTurnId: null,
                  unrelated: binding.threadId,
                  continueAfterServerUpdate: null,
                  continueAfterServerUpdatePrepared: null,
                }
              : { activeTurnId: null, unrelated: binding.threadId },
          );
          assert.deepStrictEqual(binding.resumeCursor, { cursor: binding.threadId });
        }
      }),
    ),
  );
});

it.effect(
  "settles projections when directory bindings are absent, corrupt, or fail to upsert",
  () => {
    const absent = makeThread("thread-binding-absent", "starting");
    const corrupt = makeThread("thread-binding-corrupt", "running");
    const upsertFailure = makeThread("thread-binding-upsert-failure", "running");
    const dispatched: OrchestrationCommand[] = [];
    const corruptFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.getBinding",
      detail: "corrupt persisted binding",
    });
    const writeFailure = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.upsert",
      detail: "failed binding write",
    });

    return runReconciliation({
      threads: [absent, corrupt, upsertFailure],
      directory: {
        getBinding: (candidate) =>
          candidate === absent.id
            ? Effect.succeed(Option.none())
            : candidate === corrupt.id
              ? Effect.fail(corruptFailure)
              : Effect.succeed(
                  Option.some({
                    threadId: candidate,
                    provider: ProviderDriverKind.make("codex"),
                    providerInstanceId,
                  }),
                ),
        upsert: () => Effect.fail(writeFailure),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map((command) => command.type === "thread.session.set" && command.threadId),
            [absent.id, corrupt.id, upsertFailure.id],
          );
        }),
      ),
    );
  },
);

it.effect("retries failed projections and continues after a persistent failure", () => {
  const transient = makeThread("thread-dispatch-transient-failure", "running");
  const persistent = makeThread("thread-dispatch-persistent-failure", "running");
  const later = makeThread("thread-dispatch-success", "running");
  const attempted: ThreadId[] = [];
  let transientAttempts = 0;
  const failure = new OrchestrationCommandInvariantError({
    commandType: "thread.session.set",
    detail: "simulated startup reconciliation failure",
  });

  return runReconciliation({
    threads: [transient, persistent, later],
    directory: {
      getBinding: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    },
    dispatch: (command) => {
      if (command.type !== "thread.session.set") {
        return Effect.die("unexpected command");
      }
      attempted.push(command.threadId);
      if (command.threadId === transient.id && transientAttempts++ === 0) {
        return Effect.fail(failure);
      }
      return command.threadId === persistent.id
        ? Effect.fail(failure)
        : Effect.succeed({ sequence: attempted.length });
    },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.deepStrictEqual(attempted, [
          transient.id,
          transient.id,
          persistent.id,
          persistent.id,
          later.id,
        ]),
      ),
    ),
  );
});

it.effect("does not fail startup when the live provider session inventory cannot be read", () => {
  let queried = false;
  return ServerRuntimeStartup.reconcileProviderSessions.pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getUserInputActivity: () => Effect.die("unused"),
      getCommandReadModel: () =>
        Effect.sync(() => {
          queried = true;
          return { threads: [] } as never;
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    Effect.provideService(ProviderService.ProviderService, {
      ...makeProviderService(),
      listSessions: () => Effect.die("provider inventory unavailable"),
    }),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
      getBinding: () => Effect.die("unused"),
      upsert: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.succeed([]),
    }),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest())),
    Effect.tap(() => Effect.sync(() => assert.equal(queried, false))),
  );
});

for (const scenario of [
  "disabled",
  "stopped projection",
  "finished projection",
  "stopped binding",
  "finished binding",
  "missing cursor",
  "mismatched turn",
  "marked without cursor",
  "marked stopped projection",
  "marked superseded turn",
] as const) {
  it.effect(`does not recover an interrupted session with ${scenario}`, () => {
    const turnId = TurnId.make("turn-excluded-recovery");
    const thread = makeThread(
      "thread-excluded-recovery",
      scenario.includes("stopped projection")
        ? "stopped"
        : scenario === "finished projection"
          ? "ready"
          : scenario === "marked superseded turn"
            ? "starting"
            : "running",
      scenario === "marked superseded turn" ? null : turnId,
    );
    const dispatched: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    return runReconciliation({
      threads: [thread],
      continueAfterRestart: scenario !== "disabled",
      directory: {
        getBinding: () =>
          Effect.succeed(
            Option.some({
              threadId: thread.id,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId,
              status: scenario === "stopped binding" ? "stopped" : "running",
              ...(scenario.includes("cursor") ? {} : { resumeCursor: { threadId: thread.id } }),
              runtimePayload: {
                activeTurnId:
                  scenario === "finished binding"
                    ? null
                    : scenario === "mismatched turn" || scenario === "marked superseded turn"
                      ? "another-turn"
                      : turnId,
                ...(scenario.startsWith("marked") ? { continueAfterServerUpdate: turnId } : {}),
              },
            }),
          ),
        upsert: (binding) =>
          Effect.sync(() => {
            upserts.push(binding);
          }),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            dispatched.map(
              (command) => command.type === "thread.session.set" && command.session.status,
            ),
            ["error"],
          );
          assert.deepStrictEqual(
            upserts.map((binding) => binding.status),
            ["stopped"],
          );
        }),
      ),
    );
  });
}

for (const preparedStatus of [
  "starting",
  "ready",
  "ready with failed scan",
  "completed after update marking",
] as const) {
  it.effect(`recovers again if startup exits with a prepared ${preparedStatus} session`, () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-interrupted-startup");
      const thread = makeThread("thread-interrupted-startup", "running", turnId);
      const activation = yield* Deferred.make<void>();
      const cleared = yield* Deferred.make<void>();
      const sends: ProviderSendTurnInput[] = [];
      let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
        threadId: thread.id,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "running",
        resumeCursor: { threadId: thread.id },
        runtimePayload: { activeTurnId: turnId },
      };
      const input = {
        threads: [thread],
        continueAfterRestart: true,
        providerService: {
          ...makeProviderService(),
          getCapabilities: () =>
            Effect.succeed({
              sessionModelSwitch: "in-session" as const,
              promptlessTurnContinuation: true,
            }),
          sendTurn: (input: ProviderSendTurnInput) =>
            Effect.sync(() => {
              sends.push(input);
              return { threadId: input.threadId, turnId: TurnId.make("turn-recovered") };
            }),
        },
        directory: {
          getBinding: () => Effect.sync(() => Option.some(binding)),
          upsert: (next: ProviderSessionDirectory.ProviderRuntimeBinding) =>
            Effect.gen(function* () {
              binding = next;
              if (binding.status !== "starting" || sends.length === 0) return;
              yield* Deferred.succeed(cleared, undefined);
            }),
          getProvider: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () =>
            preparedStatus === "ready with failed scan"
              ? Effect.fail(
                  new ProviderSessionDirectoryPersistenceError({
                    operation: "listBindings",
                    detail: "unreadable unrelated binding",
                  }),
                )
              : Effect.sync(() => [{ ...binding, lastSeenAt: "2026-01-01T00:00:00.000Z" }]),
        },
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            if (command.type === "thread.session.set") {
              thread.session.status = command.session.status;
              thread.session.activeTurnId = command.session.activeTurnId;
            }
            return { sequence: 1 };
          }),
      };

      yield* runReconciliation(input).pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
        Effect.scoped,
      );
      assert.deepStrictEqual(sends, []);
      assert.equal(thread.session.status, "starting");
      assert.equal(thread.session.activeTurnId, null);
      assert.deepStrictEqual(binding.runtimePayload, {
        activeTurnId: null,
        continueAfterServerUpdate: turnId,
        continueAfterServerUpdatePrepared: true,
      });

      if (preparedStatus === "completed after update marking") {
        thread.session.status = "ready";
        binding = {
          ...binding,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            continueAfterServerUpdate: turnId,
            continueAfterServerUpdatePrepared: null,
          },
        };
        yield* runReconciliation(input);
        assert.deepStrictEqual(sends, []);
        assert.equal(thread.session.status, "ready");
        return;
      }
      thread.session.status =
        preparedStatus === "ready with failed scan" ? "ready" : preparedStatus;
      yield* runReconciliation(input);
      yield* Deferred.await(cleared);
      assert.deepStrictEqual(sends, [
        { threadId: thread.id, continuation: true, interactionMode: "default" },
      ]);
      assert.deepStrictEqual(binding.runtimePayload, {
        activeTurnId: null,
        continueAfterServerUpdate: null,
        continueAfterServerUpdatePrepared: null,
      });
    }),
  );
}

it.effect("settles failed opt-in recovery without retrying the provider turn", () =>
  Effect.gen(function* () {
    const turnId = TurnId.make("turn-failed-recovery");
    const thread = makeThread("thread-failed-recovery", "running", turnId);
    const settled = yield* Deferred.make<void>();
    const sends: ProviderSendTurnInput[] = [];
    const dispatched: OrchestrationCommand[] = [];
    const preparedPayloads: unknown[] = [];
    let binding: ProviderSessionDirectory.ProviderRuntimeBinding = {
      threadId: thread.id,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: "running",
      resumeCursor: { threadId: thread.id },
      runtimePayload: { activeTurnId: turnId },
    };
    yield* runReconciliation({
      threads: [thread],
      continueAfterRestart: true,
      providerService: {
        ...makeProviderService(),
        getCapabilities: () =>
          Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            sends.push(input);
            preparedPayloads.push(binding.runtimePayload);
            return yield* Effect.fail(
              new ProviderSessionNotFoundError({ threadId: input.threadId }),
            );
          }),
      },
      directory: {
        getBinding: () => Effect.sync(() => Option.some(binding)),
        upsert: (next) =>
          Effect.sync(() => {
            binding = next;
          }),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
      },
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (command.type === "thread.session.set" && command.session.status === "error") {
            yield* Deferred.succeed(settled, undefined);
          }
          return { sequence: dispatched.length };
        }),
    });
    yield* Deferred.await(settled);
    assert.equal(sends.length, 1);
    assert.deepStrictEqual(preparedPayloads, [
      {
        activeTurnId: null,
        continueAfterServerUpdate: turnId,
        continueAfterServerUpdatePrepared: true,
      },
    ]);
    assert.deepStrictEqual(
      dispatched.map(
        (command) =>
          command.type === "thread.session.set" && {
            status: command.session.status,
            activeTurnId: command.session.activeTurnId,
          },
      ),
      [
        { status: "starting", activeTurnId: null },
        { status: "error", activeTurnId: null },
      ],
    );
    assert.equal(binding.status, "stopped");
    assert.deepStrictEqual(binding.runtimePayload, {
      activeTurnId: null,
      continueAfterServerUpdate: null,
      continueAfterServerUpdatePrepared: null,
    });
  }),
);
