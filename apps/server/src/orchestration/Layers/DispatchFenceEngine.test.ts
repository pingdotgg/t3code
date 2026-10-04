import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointStoreDieStubLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";

async function createFenceTestSystem(dbPath?: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-dispatch-fence-test-",
  });
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(
      Layer.effect(
        OrchestrationProjectionPipeline,
        Effect.gen(function* () {
          const real: OrchestrationProjectionPipelineShape = yield* OrchestrationProjectionPipeline;
          return real;
        }),
      ).pipe(Layer.provide(OrchestrationProjectionPipelineLive)),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(dbPath ? makeSqlitePersistenceLive(dbPath) : SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(CheckpointStoreDieStubLive),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

async function setupDelegatedChild(
  system: Awaited<ReturnType<typeof createFenceTestSystem>>,
  directory: string,
) {
  const projectId = ProjectId.make("fence-project");
  const parentId = ThreadId.make("fence-parent");
  const childId = ThreadId.make("fence-child");
  const at = now();
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("fence-project"),
      projectId,
      title: "Fence",
      workspaceRoot: directory,
      createdAt: at,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fence-create-parent"),
      threadId: parentId,
      projectId,
      title: parentId,
      modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: join(directory, "parent-worktree"),
      createdAt: at,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fence-create-child"),
      threadId: childId,
      projectId,
      parentThreadId: parentId,
      title: childId,
      modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "test-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: join(directory, "child-worktree"),
      delegation: {
        assignmentId: MessageId.make("fence-assignment"),
        followUp: "automatic" as const,
        completedAt: null,
      },
      createdAt: at,
    }),
  );
  // A freshly created delegation is an *initial* dispatch: minted, but with no
  // bound turn. `thread.session.set` only mints and binds the authoritative
  // (dispatch, turn) pair — and only rotates the generation when a second turn
  // replaces the first — once the assignment has actually arrived as the child's
  // latest user message. Without this delivery every session set is ignored and
  // the fence can never observe a bind or a replace.
  await system.run(
    system.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make("fence-deliver-assignment"),
      threadId: childId,
      message: {
        messageId: MessageId.make("fence-assignment"),
        role: "user",
        text: "Investigate the fence.",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: at,
    }),
  );
  return { projectId, parentId, childId };
}

function sessionSetCommand(
  threadId: ThreadId,
  turnId: TurnId | null,
  commandId: string,
  status: "running" | "ready" = "running",
) {
  return {
    type: "thread.session.set" as const,
    commandId: CommandId.make(commandId),
    threadId,
    session: {
      threadId,
      status,
      providerName: "copilot",
      providerInstanceId: ProviderInstanceId.make("copilot"),
      runtimeMode: "approval-required" as const,
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now(),
    },
    createdAt: now(),
  };
}

describe("dispatch fence engine", () => {
  it("returns the recorded verdict and never wakes twice on transport retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-fence-retry-"));
    const system = await createFenceTestSystem();
    try {
      const { parentId, childId } = await setupDelegatedChild(system, directory);
      const at = now();
      const report = {
        type: "thread.child.report" as const,
        commandId: CommandId.make("fence-report"),
        threadId: childId,
        reportId: "progress-1",
        kind: "progress" as const,
        summary: "Still working.",
        originTurnId: TurnId.make("turn-a"),
        createdAt: at,
      };
      const first = await system.run(system.engine.dispatch(report));
      expect(first.reportVerdict).toBe("accepted");
      const readModel = await system.run(system.engine.getReadModel());
      expect(readModel.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
      const second = await system.run(system.engine.dispatch(report));
      expect(second.reportVerdict).toBe("accepted");
      expect(second.sequence).toBe(first.sequence);
      const after = await system.run(system.engine.getReadModel());
      expect(after.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
    } finally {
      await system.dispose();
    }
  });

  it("fences a superseded execution across bind and replace, leaving B untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-fence-replace-"));
    const system = await createFenceTestSystem();
    try {
      const { parentId, childId } = await setupDelegatedChild(system, directory);
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-a"), "fence-session-a"),
        ),
      );
      const bound = await system.run(system.engine.getReadModel());
      const firstDispatch = bound.threads.find((entry) => entry.id === childId)?.nudging?.delegation
        ?.dispatchId;
      expect(firstDispatch).toBeDefined();
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-b"), "fence-session-b"),
        ),
      );
      const replaced = await system.run(system.engine.getReadModel());
      const secondDispatch = replaced.threads.find((entry) => entry.id === childId)?.nudging
        ?.delegation?.dispatchId;
      expect(secondDispatch).toBeDefined();
      expect(secondDispatch).not.toBe(firstDispatch);
      const stale = await system.run(
        system.engine.dispatch({
          type: "thread.child.report" as const,
          commandId: CommandId.make("fence-late-a"),
          threadId: childId,
          reportId: "late-a",
          kind: "decision-needed" as const,
          summary: "Late question from the superseded turn.",
          dispatchId: firstDispatch!,
          originTurnId: TurnId.make("turn-a"),
          createdAt: now(),
        }),
      );
      expect(stale.reportVerdict).toBe("stale");
      const state = await system.run(system.engine.getReadModel());
      expect(state.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
      expect(
        state.threads.find((entry) => entry.id === childId)?.nudging?.delegation,
      ).toMatchObject({
        dispatchId: secondDispatch,
        completedAt: null,
      });
    } finally {
      await system.dispose();
    }
  });

  it("replays a lost accepted acknowledgement after execution replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-fence-lost-ack-"));
    const system = await createFenceTestSystem();
    try {
      const { parentId, childId } = await setupDelegatedChild(system, directory);
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-a"), "fence-lost-session-a"),
        ),
      );
      const bound = await system.run(system.engine.getReadModel());
      const delegation = bound.threads.find((entry) => entry.id === childId)?.nudging?.delegation;
      expect(delegation?.dispatchId).toBeDefined();
      const report = {
        type: "thread.child.report" as const,
        threadId: childId,
        reportId: "result-a",
        kind: "important-update" as const,
        summary: "Execution A produced a result.",
        assignmentId: delegation!.assignmentId,
        dispatchId: delegation!.dispatchId!,
        originTurnId: TurnId.make("turn-a"),
        createdAt: now(),
      };
      const accepted = await system.run(
        system.engine.dispatch({
          ...report,
          commandId: CommandId.make("fence-lost-report-a"),
        }),
      );
      expect(accepted.reportVerdict).toBe("accepted");
      const queuedBefore = (await system.run(system.engine.getReadModel())).threads.find(
        (entry) => entry.id === parentId,
      )?.queuedTurns;
      expect(queuedBefore).toHaveLength(1);
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-b"), "fence-lost-session-b"),
        ),
      );
      const replayed = await system.run(
        system.engine.dispatch({
          ...report,
          commandId: CommandId.make("fence-lost-report-a-retry"),
        }),
      );
      expect(replayed.reportVerdict).toBe("accepted");
      const after = await system.run(system.engine.getReadModel());
      expect(after.threads.find((entry) => entry.id === parentId)?.queuedTurns).toHaveLength(1);
      expect(
        after.threads.find((entry) => entry.id === childId)?.nudging?.delegation?.dispatchId,
      ).not.toBe(delegation!.dispatchId);
    } finally {
      await system.dispose();
    }
  });

  it("replays an original stale outcome instead of reclassifying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-fence-stale-replay-"));
    const system = await createFenceTestSystem();
    try {
      const { parentId, childId } = await setupDelegatedChild(system, directory);
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-a"), "fence-stale-session-a"),
        ),
      );
      const first = await system.run(system.engine.getReadModel());
      const delegation = first.threads.find((entry) => entry.id === childId)?.nudging?.delegation;
      await system.run(
        system.engine.dispatch(
          sessionSetCommand(childId, TurnId.make("turn-b"), "fence-stale-session-b"),
        ),
      );
      const report = {
        type: "thread.child.report" as const,
        threadId: childId,
        reportId: "stale-a",
        kind: "important-update" as const,
        summary: "Superseded execution A update.",
        assignmentId: delegation!.assignmentId,
        dispatchId: delegation!.dispatchId!,
        originTurnId: TurnId.make("turn-a"),
        createdAt: now(),
      };
      const stale = await system.run(
        system.engine.dispatch({
          ...report,
          commandId: CommandId.make("fence-stale-report-a"),
        }),
      );
      expect(stale.reportVerdict).toBe("stale");
      const replayed = await system.run(
        system.engine.dispatch({
          ...report,
          commandId: CommandId.make("fence-stale-report-a-retry"),
        }),
      );
      expect(replayed.reportVerdict).toBe("stale");
      const after = await system.run(system.engine.getReadModel());
      expect(after.threads.find((entry) => entry.id === parentId)?.queuedTurns).toEqual([]);
    } finally {
      await system.dispose();
    }
  });

  it("retains the active generation across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3-fence-restart-"));
    const dbPath = join(directory, "state.sqlite");
    let system = await createFenceTestSystem(dbPath);
    let secondDispatch: string;
    try {
      const { childId } = await setupDelegatedChild(system, directory);
      await system.run(
        system.engine.dispatch(sessionSetCommand(childId, TurnId.make("turn-a"), "fence-rs-a")),
      );
      await system.run(
        system.engine.dispatch(sessionSetCommand(childId, TurnId.make("turn-b"), "fence-rs-b")),
      );
      const state = await system.run(system.engine.getReadModel());
      const persistedDispatch = state.threads.find((entry) => entry.id === childId)?.nudging
        ?.delegation?.dispatchId;
      expect(persistedDispatch).toBeDefined();
      secondDispatch = persistedDispatch!;
    } finally {
      await system.dispose();
    }
    system = await createFenceTestSystem(dbPath);
    try {
      const stale = await system.run(
        system.engine.dispatch({
          type: "thread.child.report" as const,
          commandId: CommandId.make("fence-rs-late"),
          threadId: ThreadId.make("fence-child"),
          reportId: "late-a",
          kind: "important-update" as const,
          summary: "Late update after restart.",
          originTurnId: TurnId.make("turn-a"),
          createdAt: now(),
        }),
      );
      expect(stale.reportVerdict).toBe("stale");
      const state = await system.run(system.engine.getReadModel());
      expect(
        state.threads.find((entry) => entry.id === ThreadId.make("fence-child"))?.nudging
          ?.delegation?.dispatchId,
      ).toBe(secondDispatch!);
    } finally {
      await system.dispose();
    }
  });
});
