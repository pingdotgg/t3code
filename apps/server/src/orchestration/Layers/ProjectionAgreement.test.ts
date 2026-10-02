import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

/**
 * The in-memory read model and the durable SQL projection are two independent
 * implementations of "what an event means", and both are live on every dispatch
 * (`OrchestrationEngine` appends the event, then folds it in memory, then hands
 * it to the SQL pipeline). `projection/ProjectionPolicy.ts` owns the decisions
 * they must agree on, but nothing enforced that they actually did.
 *
 * These tests drive real commands through the real engine and then compare what
 * the two projections say about the same thread. They exist because the two have
 * already drifted twice: the snapshot reader dropped `session.activeMessageId`
 * entirely, and it reported an orphaned running turn as still running while the
 * projector had already terminalised it. Both defects made a thread the server
 * would admit look busy to the client, or vice versa.
 *
 * Only fields both projections own are compared. The in-memory model caps
 * activities and the reader applies its own windowing, so whole-object equality
 * is not a meaningful assertion here.
 */

const projectId = ProjectId.make("agreement-project");
const threadId = ThreadId.make("agreement-thread");
const turnId = TurnId.make("agreement-turn");
const assistantMessageId = MessageId.make("agreement-assistant-message");

const at = (offsetMs: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-agreement-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** The fields the in-memory projector and the SQL reader both decide. */
const comparableSession = (session: OrchestrationSession | null) =>
  session === null
    ? null
    : {
        status: session.status,
        activeTurnId: session.activeTurnId,
        activeMessageId: session.activeMessageId ?? null,
        lastError: session.lastError,
      };

const comparableTurn = (turn: OrchestrationLatestTurn | null) =>
  turn === null
    ? null
    : {
        turnId: turn.turnId,
        state: turn.state,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        assistantMessageId: turn.assistantMessageId,
      };

/**
 * Asserts the in-memory read model and the SQL reader agree about a thread.
 * `getThreadShellById` is the path clients actually use for the sidebar and
 * thread list, so it is the one that has to agree with what the decider sees.
 */
const assertProjectionsAgree = Effect.fn("assertProjectionsAgree")(function* (target: ThreadId) {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const inMemory = yield* engine.getReadModel();
  const inMemoryThread = inMemory.threads.find((entry) => entry.id === target);
  assert.isDefined(inMemoryThread, "in-memory read model is missing the thread");

  const read = yield* snapshotQuery.getThreadShellById(target);
  if (read._tag !== "Some") {
    return yield* Effect.die("SQL reader is missing the thread");
  }
  const readShell = read.value;

  assert.deepStrictEqual(
    comparableSession(readShell.session),
    comparableSession(inMemoryThread.session),
    "session diverged between the in-memory projector and the SQL projection",
  );
  assert.deepStrictEqual(
    comparableTurn(readShell.latestTurn),
    comparableTurn(inMemoryThread.latestTurn),
    "latest turn diverged between the in-memory projector and the SQL projection",
  );
});

layer("projection agreement", (it) => {
  it.effect("keeps both projections in step through a full turn lifecycle", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("agreement-project"),
        projectId,
        title: "Agreement",
        workspaceRoot: "/tmp/t3-projection-agreement",
        defaultModelSelection: null,
        createdAt: at(0),
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("agreement-thread-create"),
        threadId,
        projectId,
        title: "Agreement thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/t3-projection-agreement-thread",
        createdAt: at(1_000),
      });
      yield* assertProjectionsAgree(threadId);

      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("agreement-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: turnId,
          activeMessageId: assistantMessageId,
          lastError: null,
          updatedAt: at(3_000),
        },
        createdAt: at(3_000),
      });
      yield* assertProjectionsAgree(threadId);

      // The field the reader used to drop.
      const inMemory = yield* engine.getReadModel();
      assert.strictEqual(
        inMemory.threads.find((entry) => entry.id === threadId)?.session?.activeMessageId,
        assistantMessageId,
        "precondition: the in-memory projector records activeMessageId",
      );

      // Orphaned turn: both must terminalise it.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("agreement-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: at(6_000),
        },
        createdAt: at(6_000),
      });
      yield* assertProjectionsAgree(threadId);

      const shell = yield* (yield* ProjectionSnapshotQuery).getThreadShellById(threadId);
      if (shell._tag !== "Some") {
        return yield* Effect.die("SQL reader is missing the thread");
      }
      const readShell = shell.value;
      const memory = (yield* engine.getReadModel()).threads.find((entry) => entry.id === threadId);
      assert.notStrictEqual(
        memory?.latestTurn?.state,
        "running",
        "precondition: a session that stopped terminalises the orphaned turn",
      );
      assert.strictEqual(
        readShell.latestTurn?.state,
        memory?.latestTurn?.state,
        "reader and projector must agree that the turn is no longer running",
      );
    }),
  );

  it.effect("agrees on turn state while the turn is genuinely still running", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("agreement-running-project"),
        projectId: ProjectId.make("agreement-running-project"),
        title: "Agreement running",
        workspaceRoot: "/tmp/t3-projection-agreement-running",
        defaultModelSelection: null,
        createdAt: at(0),
      });
      const runningThreadId = ThreadId.make("agreement-running-thread");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("agreement-running-thread-create"),
        threadId: runningThreadId,
        projectId: ProjectId.make("agreement-running-project"),
        title: "Agreement running thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/t3-projection-agreement-running-thread",
        createdAt: at(1_000),
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("agreement-running-session"),
        threadId: runningThreadId,
        session: {
          threadId: runningThreadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: at(2_000),
        },
        createdAt: at(2_000),
      });
      yield* assertProjectionsAgree(runningThreadId);

      const memory = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === runningThreadId,
      );
      assert.strictEqual(
        memory?.latestTurn?.state,
        "running",
        "precondition: a running session keeps the turn running",
      );
    }),
  );
});
