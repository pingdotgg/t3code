import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryPersistenceError } from "./provider/Errors.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const updatedAt = "2026-08-20T12:00:00.000Z";

const makeThread = (
  id: string,
  status: "starting" | "running" | "ready" | "stopped" | "error",
  activeTurnId: TurnId | null = null,
  archivedAt: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt: null,
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
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as never)),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    uploadFeedback: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderService.ProviderService["Service"];

const queryWithThreads = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  ({
    getCommandReadModel: () => Effect.succeed({ threads } as never),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const runReconciliation = (input: {
  readonly threads: ReadonlyArray<ReturnType<typeof makeThread>>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
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
      makeProviderService(input.liveThreadIds),
    ),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: input.dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );

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
              runtimePayload: { activeTurnId: "stale", unrelated: candidate },
            }),
          ),
        ),
      upsert: (binding) => Effect.sync(() => upserts.push(binding)),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.die("unused"),
      listBindings: () => Effect.die("unused"),
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
          assert.deepStrictEqual(binding.runtimePayload, { activeTurnId: null });
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
        listBindings: () => Effect.die("unused"),
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
      listBindings: () => Effect.die("unused"),
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
      listBindings: () => Effect.die("unused"),
    }),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
    Effect.tap(() => Effect.sync(() => assert.equal(queried, false))),
  );
});
