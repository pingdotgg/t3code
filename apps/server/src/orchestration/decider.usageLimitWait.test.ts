import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationUsageLimitWait,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const CREATED_AT = "2026-08-14T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-usage-limit");
const BLOCKED_TURN_ID = TurnId.make("turn-blocked");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const WAIT: OrchestrationUsageLimitWait = {
  waitId: CommandId.make("wait-1"),
  blockedTurnId: BLOCKED_TURN_ID,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: MODEL_SELECTION,
  resumeAt: "2026-08-14T05:00:30.000Z",
  limitType: "five-hour",
  isEstimated: false,
  createdAt: CREATED_AT,
};

function makeReadModel(
  usageLimitWait: OrchestrationUsageLimitWait | null = null,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Usage limited thread",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: BLOCKED_TURN_ID,
          state: "error",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: CREATED_AT,
          assistantMessageId: null,
        },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        usageLimitWait,
        deletedAt: null,
        messages: [
          {
            id: MessageId.make("message-user-1"),
            role: "user",
            text: "Finish the migration",
            turnId: BLOCKED_TURN_ID,
            streaming: false,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "error",
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Usage limit reached",
          updatedAt: CREATED_AT,
        },
      },
    ],
    updatedAt: CREATED_AT,
  };
}

it.layer(NodeServices.layer)("usage-limit wait decider", (it) => {
  it.effect("schedules a wait only for the blocked failed turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-wait.schedule",
          commandId: WAIT.waitId,
          threadId: THREAD_ID,
          wait: WAIT,
          createdAt: CREATED_AT,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.usage-limit-wait-scheduled");
      if (events[0]?.type === "thread.usage-limit-wait-scheduled") {
        expect(events[0].payload.wait).toEqual(WAIT);
      }
    }),
  );

  it.effect("resumes with a hidden continuation prompt and clears the wait atomically", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-wait.resume",
          commandId: CommandId.make("resume-wait-1"),
          threadId: THREAD_ID,
          waitId: WAIT.waitId,
          createdAt: WAIT.resumeAt,
        },
        readModel: makeReadModel(WAIT),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.usage-limit-wait-cleared",
        "thread.turn-start-requested",
      ]);
      const start = events[1];
      if (start?.type === "thread.turn-start-requested") {
        expect(start.payload.messageId).toBe("message-user-1");
        expect(start.payload.origin).toBe("usage-limit-auto-resume");
        expect(start.payload.promptOverride).toBe(
          "Continue the task from where you left off. Do not repeat work that is already complete.",
        );
      }
    }),
  );

  it.effect("cancels only the matching scheduled wait", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-wait.cancel",
          commandId: CommandId.make("cancel-wait-1"),
          threadId: THREAD_ID,
          waitId: WAIT.waitId,
          createdAt: CREATED_AT,
        },
        readModel: makeReadModel(WAIT),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events[0]?.type).toBe("thread.usage-limit-wait-cleared");
      if (events[0]?.type === "thread.usage-limit-wait-cleared") {
        expect(events[0].payload.waitId).toBe(WAIT.waitId);
        expect(events[0].payload.reason).toBe("user");
      }
    }),
  );

  it.effect("a manual message supersedes the wait and starts immediately", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("manual-turn-after-limit"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-user-2"),
            role: "user",
            text: "Continue with this agent instead",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-08-14T00:01:00.000Z",
        },
        readModel: makeReadModel(WAIT),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.usage-limit-wait-cleared",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const cleared = events[0];
      if (cleared?.type === "thread.usage-limit-wait-cleared") {
        expect(cleared.payload.reason).toBe("superseded");
      }
    }),
  );
});
