import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  buildThreadMessageCorrectionProviderText,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const TARGET_AT = "2026-08-16T09:00:00.000Z";
const CORRECTION_AT = "2026-08-16T10:00:00.000Z";

function userMessage(id: string, text: string, createdAt = TARGET_AT) {
  return {
    id: MessageId.make(id),
    role: "user" as const,
    text,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "interrupted",
      requestedAt: TARGET_AT,
      startedAt: TARGET_AT,
      completedAt: "2026-08-16T09:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: TARGET_AT,
    updatedAt: TARGET_AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [userMessage("message-1", "Original request")],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function readModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: CORRECTION_AT,
  };
}

const command = {
  type: "thread.message.correct" as const,
  commandId: CommandId.make("command-correction-1"),
  threadId: ThreadId.make("thread-1"),
  targetMessageId: MessageId.make("message-1"),
  correctionMessageId: MessageId.make("message-correction-1"),
  expectedText: "Original request",
  replacementText: "Corrected request",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
  createdAt: CORRECTION_AT,
};

it.layer(NodeServices.layer)("message correction decider", (it) => {
  it.effect("emits one durable correction and one normal turn start", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: readModel(
          makeThread({
            settledOverride: "settled",
            settledAt: TARGET_AT,
            snoozedUntil: "2026-08-17T09:00:00.000Z",
            snoozedAt: TARGET_AT,
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.message-corrected",
        "thread.turn-start-requested",
      ]);
      const corrected = events[2];
      const turnStart = events[3];
      expect(corrected?.type).toBe("thread.message-corrected");
      expect(turnStart?.type).toBe("thread.turn-start-requested");
      if (corrected?.type !== "thread.message-corrected") return;
      if (turnStart?.type !== "thread.turn-start-requested") return;
      expect(corrected.payload.providerText).toBe(
        buildThreadMessageCorrectionProviderText(command.replacementText),
      );
      expect(turnStart.payload.messageId).toBe(command.correctionMessageId);
      expect(turnStart.payload.modelSelection).toEqual(command.modelSelection);
      expect(turnStart.payload.runtimeMode).toBe("full-access");
      expect(turnStart.payload.interactionMode).toBe("default");
      expect(turnStart.causationEventId).toBe(corrected.eventId);
    }),
  );

  it.effect(
    "rejects stale, revertible, active, queued, blocked, empty, and unchanged targets",
    () =>
      Effect.gen(function* () {
        const assistant = {
          id: MessageId.make("assistant-1"),
          role: "assistant" as const,
          text: "Done",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: TARGET_AT,
          updatedAt: TARGET_AT,
        };
        const variants: ReadonlyArray<{
          readonly name: string;
          readonly thread: OrchestrationThread;
          readonly replacementText?: string;
          readonly expectedText?: string;
          readonly correctionMessageId?: MessageId;
        }> = [
          {
            name: "stale",
            thread: makeThread({
              messages: [
                userMessage("message-1", "Original request"),
                userMessage("message-2", "Newer request", "2026-08-16T09:30:00.000Z"),
              ],
            }),
          },
          {
            name: "target-changed",
            thread: makeThread(),
            expectedText: "An older client revision",
          },
          {
            name: "message-id-collision",
            thread: makeThread(),
            correctionMessageId: MessageId.make("message-1"),
          },
          {
            name: "revertible",
            thread: makeThread({
              messages: [userMessage("message-1", "Original request"), assistant],
              checkpoints: [
                {
                  turnId: TurnId.make("turn-1"),
                  checkpointTurnCount: 1,
                  checkpointRef: "refs/t3/checkpoints/thread-1/turn/1" as never,
                  status: "ready",
                  files: [],
                  assistantMessageId: assistant.id,
                  completedAt: TARGET_AT,
                },
              ],
            }),
          },
          {
            name: "active",
            thread: makeThread({
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "running",
                providerName: "Codex",
                runtimeMode: "full-access",
                activeTurnId: TurnId.make("turn-1"),
                lastError: null,
                updatedAt: CORRECTION_AT,
              },
            }),
          },
          {
            name: "queued",
            thread: makeThread({
              latestTurn: null,
              messages: [userMessage("message-1", "Original request", CORRECTION_AT)],
            }),
          },
          {
            name: "blocked",
            thread: makeThread({
              activities: [
                {
                  id: EventId.make("activity-approval"),
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "Approval requested",
                  payload: { requestId: "request-1" },
                  turnId: null,
                  createdAt: TARGET_AT,
                },
              ],
            }),
          },
          { name: "empty", thread: makeThread(), replacementText: "   " },
          { name: "unchanged", thread: makeThread(), replacementText: "Original request" },
        ];

        for (const variant of variants) {
          const exit = yield* Effect.exit(
            decideOrchestrationCommand({
              command: {
                ...command,
                commandId: CommandId.make(`command-${variant.name}`),
                expectedText: variant.expectedText ?? command.expectedText,
                correctionMessageId: variant.correctionMessageId ?? command.correctionMessageId,
                replacementText: variant.replacementText ?? command.replacementText,
              },
              readModel: readModel(variant.thread),
            }),
          );
          expect(exit._tag, variant.name).toBe("Failure");
        }
      }),
  );
});
