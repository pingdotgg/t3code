import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CheckoutCoordinator } from "../../git/CheckoutCoordinator.ts";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DelegationAuditRepository } from "../../persistence/Services/DelegationAudit.ts";
import type { DelegationAuditRepositoryShape } from "../../persistence/Services/DelegationAudit.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointStoreDieStubLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

async function createLatencySystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-dispatch-latency-",
  });
  const delegationAuditRepository: DelegationAuditRepositoryShape = {
    begin: (input) =>
      Effect.succeed({
        operationId: input.operationId,
        sourceThreadId: input.sourceThreadId,
        sourceTurnId: input.sourceTurnId,
        sourceMessageId: input.sourceMessageId,
        initiatingMessageId: input.initiatingMessageId,
      }),
    append: () => Effect.void,
    page: (input) =>
      Effect.succeed({
        sourceThreadId: input.sourceThreadId ?? ThreadId.make("missing-source"),
        events: [],
        cleanupStates: [],
        nextBeforeSequence: null,
        hasMore: false,
        warnings: [],
      }),
    getOperationSource: () => Effect.succeed(Option.none()),
    getAttemptForChild: () => Effect.succeed(Option.none()),
    deleteBySourceThreadId: () => Effect.void,
  };
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(DelegationAuditRepository, delegationAuditRepository)),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(CheckpointStoreDieStubLive),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const coordinator = await runtime.runPromise(Effect.service(CheckoutCoordinator));
  return {
    engine,
    coordinator,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine dispatch latency", () => {
  it("does not head-of-line block other threads behind a gated checkout", async () => {
    const system = await createLatencySystem();
    const gateEntered = Effect.runSync(Deferred.make<void>());
    const releaseGate = Effect.runSync(Deferred.make<void>());
    const projectId = ProjectId.make("latency-project");
    const threadA = ThreadId.make("latency-thread-a");
    const threadB = ThreadId.make("latency-thread-b");
    const cwdA = "/tmp/dispatch-latency-worktree-a";
    const cwdB = "/tmp/dispatch-latency-worktree-b";
    const createdAt = now();
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const message = {
      messageId: MessageId.make("latency-message-a"),
      role: "user" as const,
      text: "hello",
      attachments: [],
    };
    let slow: Promise<unknown> | undefined;
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("latency-project-create"),
          projectId,
          title: "Latency",
          workspaceRoot: "/tmp/dispatch-latency-project",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      for (const [threadId, worktreePath, commandId] of [
        [threadA, cwdA, "latency-thread-a-create"],
        [threadB, cwdB, "latency-thread-b-create"],
      ] as const) {
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(commandId),
            threadId,
            projectId,
            title: "Latency",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath,
            createdAt,
          }),
        );
      }

      // Park thread A's turn behind its per-checkout lock. A command for any
      // other thread must still commit while this gate is closed.
      const withCheckout = system.coordinator.withCheckout;
      vi.spyOn(system.coordinator, "withCheckout").mockImplementation((path, effect) =>
        path === cwdA
          ? Deferred.succeed(gateEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseGate)),
              Effect.andThen(withCheckout(path, effect)),
            )
          : withCheckout(path, effect),
      );
      slow = system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("latency-turn-a"),
          threadId: threadA,
          message,
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
      await system.run(Deferred.await(gateEntered));

      // A fast command on an unrelated thread must not wait for A's checkout.
      // The timeout turns head-of-line blocking into a failure instead of a hang.
      const fast = await system.run(
        system.engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("latency-activity-b"),
            threadId: threadB,
            activity: {
              id: EventId.make("latency-activity-b-1"),
              tone: "info",
              kind: "status",
              summary: "independent work",
              payload: {},
              turnId: null,
              createdAt: now(),
            },
            createdAt: now(),
          })
          .pipe(Effect.timeoutOption("10 seconds")),
      );
      expect(Option.isSome(fast)).toBe(true);

      await system.run(Deferred.succeed(releaseGate, undefined));
      const slowResult = (await slow) as { readonly sequence: number };
      const fastResult = Option.getOrThrow(fast) as { readonly sequence: number };
      expect(slowResult.sequence).toBeGreaterThan(0);
      expect(fastResult.sequence).toBeGreaterThan(0);
      expect(slowResult.sequence).not.toBe(fastResult.sequence);

      // Both threads converge in one consistent read model: A's turn is active
      // and B's activity survived the interleaved commits.
      const readModel = await system.run(system.engine.getReadModel());
      const modelA = readModel.threads.find((thread) => thread.id === threadA);
      const modelB = readModel.threads.find((thread) => thread.id === threadB);
      expect(modelA?.session?.activeTurnId).not.toBeNull();
      expect(modelB?.activities.some((activity) => activity.id === "latency-activity-b-1")).toBe(
        true,
      );
      expect(modelA?.messages.some((entry) => entry.id === message.messageId)).toBe(true);
      expect(readModel.snapshotSequence).toBeGreaterThanOrEqual(
        Math.max(slowResult.sequence, fastResult.sequence),
      );
    } finally {
      await system.run(Deferred.succeed(releaseGate, undefined));
      await Promise.allSettled([slow]);
      vi.restoreAllMocks();
      await system.dispose();
    }
  });
});
