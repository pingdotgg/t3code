import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ApprovalRequestId,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("question-1");

function makeRequest(responseMode: "message" | undefined): OrchestrationThreadActivity {
  return {
    id: EventId.make(requestId),
    kind: "user-input.requested",
    summary: "Question",
    tone: "approval",
    turnId: null,
    createdAt: NOW,
    payload: {
      requestId,
      ...(responseMode === undefined ? {} : { responseMode }),
      questions: [{ id: "0", header: "Q", question: "Continue?", options: [] }],
    },
  };
}

function makeReadModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [...activities],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const command = {
  type: "thread.user-input.dismiss" as const,
  commandId: CommandId.make("dismiss-1"),
  threadId,
  requestId,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("user input dismiss decider", (it) => {
  it.effect("closes an async question without sending a message or starting a turn", () =>
    Effect.gen(function* () {
      const request = makeRequest("message");
      const readModel = makeReadModel([request]);
      const result = yield* decideOrchestrationCommand({
        command,
        readModel,
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      expect(events[0]?.payload).toMatchObject({
        threadId,
        activity: {
          kind: "user-input.resolved",
          summary: "User input dismissed",
          payload: { requestId, responseMode: "message" },
        },
      });
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.messages).toEqual([]);
      expect(projected.threads[0]?.latestTurn).toBeNull();
    }),
  );

  it.effect("rejects dismissing a native callback question", () =>
    Effect.gen(function* () {
      const request = makeRequest(undefined);
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([request]),
        userInputActivity: request,
      }).pipe(Effect.flip);
      expect(result).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "This question needs an answer. Answer it or stop the turn.",
      });
    }),
  );

  it.effect("rejects dismissing a question that was already resolved", () =>
    Effect.gen(function* () {
      const resolved: OrchestrationThreadActivity = {
        ...makeRequest("message"),
        id: EventId.make("resolved"),
        kind: "user-input.resolved",
      };
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([makeRequest("message"), resolved]),
        userInputActivity: resolved,
      }).pipe(Effect.flip);
      expect(result).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "This question has already been answered.",
      });
    }),
  );
});
