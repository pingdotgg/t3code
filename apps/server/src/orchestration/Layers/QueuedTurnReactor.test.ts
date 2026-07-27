import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { QueuedTurnReactorLive } from "./QueuedTurnReactor.ts";

const now = "2026-03-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-queued-startup");
const queuedTurnId = QueuedTurnId.make("queued-turn-startup");

function queuedReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Queued startup",
        modelSelection: {
          instanceId: ProviderInstanceId.make("copilot"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/handoff",
        worktreePath: "/tmp/handoff",
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        queuedTurns: [
          {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: MessageId.make("message-startup"),
              role: "user",
              text: "continue after restart",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
          },
        ],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    workflowRuns: [],
    updatedAt: now,
  };
}

describe("QueuedTurnReactor", () => {
  it("dispatches a persisted continuation exactly once when the server restarts", async () => {
    let readModel = queuedReadModel();
    const commands: OrchestrationCommand[] = [];
    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.queued-turn.dispatch") {
            readModel = {
              ...readModel,
              threads: readModel.threads.map((thread) =>
                thread.id === command.threadId ? { ...thread, queuedTurns: [] } : thread,
              ),
            };
          }
          return { sequence: 2 };
        }),
      streamDomainEvents: Stream.never,
    });
    const layer = QueuedTurnReactorLive.pipe(Layer.provide(engineLayer));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* QueuedTurnReactor;
          yield* reactor.start();
          yield* Effect.sleep("10 millis");
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
    expect(commands[0]?.commandId).toEqual(expect.stringMatching(/^server:queued-turn\.dispatch:/));
  });
});
