import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { findThreadHandoff } from "./threadHandoff.ts";

const NOW = "2026-08-18T12:00:00.000Z";
const SOURCE_THREAD_ID = ThreadId.make("source-thread");
const TARGET_THREAD_ID = ThreadId.make("target-thread");
const PROJECT_ID = ProjectId.make("project-1");
const HANDOFF_ID = "handoff-1";
const TURN_ID = TurnId.make("turn-1");

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/workspace/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Source thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [{ id: "effort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "feature/handoff",
        worktreePath: "/workspace/handoff",
        latestTurn: {
          turnId: TURN_ID,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: SOURCE_THREAD_ID,
          status: "running",
          providerName: "Codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TURN_ID,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  };
}

function asEvents(
  value: Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Array.isArray(value) ? value : [value];
}

function projectAll(
  model: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Effect.gen(function* () {
    let next = model;
    for (const event of events) {
      next = yield* projectEvent(next, {
        ...event,
        sequence: next.snapshotSequence + 1,
      } as OrchestrationEvent);
    }
    return next;
  });
}

it.layer(NodeServices.layer)("thread handoff decider", (it) => {
  it.effect("makes a requested handoff visible only after its source turn completes", () =>
    Effect.gen(function* () {
      const requested = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.request",
            commandId: CommandId.make("request-handoff"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            title: "Implementation",
            prompt: "Implement docs/spec.md",
            artifactReferences: ["docs/spec.md", "abc123"],
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );
      const requestedModel = yield* projectAll(makeReadModel(), requested);

      expect(findThreadHandoff(requestedModel.threads[0]!, HANDOFF_ID)?.state).toBe("pending");

      const available = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.turn-settle",
            commandId: CommandId.make("handoff-turn-completed"),
            threadId: SOURCE_THREAD_ID,
            turnId: TURN_ID,
            outcome: "completed",
            createdAt: NOW,
          },
          readModel: requestedModel,
        }),
      );
      const completedModel = yield* projectAll(requestedModel, available);

      expect(findThreadHandoff(completedModel.threads[0]!, HANDOFF_ID)?.state).toBe("available");
    }),
  );

  it.effect("creates one linked unstarted target with inherited source settings", () =>
    Effect.gen(function* () {
      const requested = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.request",
            commandId: CommandId.make("request-handoff"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            title: "Implementation",
            prompt: "Implement docs/spec.md",
            artifactReferences: ["docs/spec.md"],
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );
      const requestedModel = yield* projectAll(makeReadModel(), requested);
      const available = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.turn-settle",
            commandId: CommandId.make("handoff-turn-completed"),
            threadId: SOURCE_THREAD_ID,
            turnId: TURN_ID,
            outcome: "completed",
            createdAt: NOW,
          },
          readModel: requestedModel,
        }),
      );
      const availableModel = yield* projectAll(requestedModel, available);

      const accepted = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.accept",
            commandId: CommandId.make("accept-handoff"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            targetThreadId: TARGET_THREAD_ID,
            createdAt: NOW,
          },
          readModel: availableModel,
        }),
      );

      expect(accepted.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.created",
        "thread.activity-appended",
      ]);
      const targetCreated = accepted[1];
      expect(targetCreated?.type).toBe("thread.created");
      if (targetCreated?.type === "thread.created") {
        expect(targetCreated.payload).toMatchObject({
          threadId: TARGET_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Implementation",
          modelSelection: makeReadModel().threads[0]!.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: "feature/handoff",
          worktreePath: "/workspace/handoff",
        });
      }

      const acceptedModel = yield* projectAll(availableModel, accepted);
      const sourceHandoff = findThreadHandoff(acceptedModel.threads[0]!, HANDOFF_ID);
      const target = acceptedModel.threads.find((thread) => thread.id === TARGET_THREAD_ID);
      expect(sourceHandoff).toMatchObject({ state: "accepted", targetThreadId: TARGET_THREAD_ID });
      expect(target?.session).toBeNull();
      expect(target?.messages).toEqual([]);
      expect(findThreadHandoff(target!, HANDOFF_ID)).toMatchObject({
        sourceThreadId: SOURCE_THREAD_ID,
        prompt: "Implement docs/spec.md",
      });

      const duplicate = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.handoff.accept",
            commandId: CommandId.make("accept-handoff-again"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            targetThreadId: ThreadId.make("duplicate-target"),
            createdAt: NOW,
          },
          readModel: acceptedModel,
        }),
      );
      expect(duplicate._tag).toBe("Failure");
    }),
  );

  it.effect("cancels a request when its source turn fails", () =>
    Effect.gen(function* () {
      const requested = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.request",
            commandId: CommandId.make("request-handoff"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            title: "Implementation",
            prompt: "Implement docs/spec.md",
            artifactReferences: [],
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );
      const requestedModel = yield* projectAll(makeReadModel(), requested);
      const cancelled = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.turn-settle",
            commandId: CommandId.make("handoff-turn-failed"),
            threadId: SOURCE_THREAD_ID,
            turnId: TURN_ID,
            outcome: "failed",
            createdAt: NOW,
          },
          readModel: requestedModel,
        }),
      );
      const cancelledModel = yield* projectAll(requestedModel, cancelled);
      expect(findThreadHandoff(cancelledModel.threads[0]!, HANDOFF_ID)?.state).toBe("cancelled");
    }),
  );

  it.effect("dismisses an available handoff without creating a target", () =>
    Effect.gen(function* () {
      const runningModel = makeReadModel();
      const completedModel: OrchestrationReadModel = {
        ...runningModel,
        threads: runningModel.threads.map((thread) => ({
          ...thread,
          session: null,
          latestTurn: thread.latestTurn
            ? {
                ...thread.latestTurn,
                state: "completed" as const,
                completedAt: NOW,
              }
            : null,
        })),
      };
      const requested = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.request",
            commandId: CommandId.make("request-handoff-completed"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            title: "Implementation",
            prompt: "Implement docs/spec.md",
            artifactReferences: [],
            requestingTurnId: TURN_ID,
            availableImmediately: true,
            createdAt: NOW,
          },
          readModel: completedModel,
        }),
      );
      const availableModel = yield* projectAll(completedModel, requested);
      const dismissed = asEvents(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.handoff.dismiss",
            commandId: CommandId.make("dismiss-handoff"),
            threadId: SOURCE_THREAD_ID,
            handoffId: HANDOFF_ID,
            createdAt: NOW,
          },
          readModel: availableModel,
        }),
      );

      expect(dismissed.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      const dismissedModel = yield* projectAll(availableModel, dismissed);
      expect(findThreadHandoff(dismissedModel.threads[0]!, HANDOFF_ID)?.state).toBe("dismissed");
      expect(dismissedModel.threads).toHaveLength(1);
    }),
  );
});
