import {
  ApprovalRequestId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      pullRequests: [],
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
      pinOrderKey: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: ["approval-1", "approval-2"].map((requestId, index) => ({
        id: EventId.make(`event-${index}`),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "Approval required",
        payload: { requestId },
        sequence: index + 9,
        turnId: null,
        createdAt: NOW,
      })),
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("grouped approval decider", (it) => {
  it.effect("emits every approval response from one atomic command decision", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.approval.batch-respond",
          commandId: CommandId.make("cmd-batch-approval"),
          threadId: ThreadId.make("thread-1"),
          responses: [
            { requestId: ApprovalRequestId.make("approval-1"), decision: "accept" },
            { requestId: ApprovalRequestId.make("approval-2"), decision: "decline" },
          ],
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(2);
      expect(events.map((event) => event.commandId)).toEqual([
        CommandId.make("cmd-batch-approval"),
        CommandId.make("cmd-batch-approval"),
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "thread.approval-response-requested",
        "thread.approval-response-requested",
      ]);
    }),
  );

  it.effect("rejects the whole batch when the approval plan revision is stale", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.approval.batch-respond",
          commandId: CommandId.make("cmd-stale-batch"),
          threadId: ThreadId.make("thread-1"),
          expectedRevision: 9,
          responses: [{ requestId: ApprovalRequestId.make("approval-1"), decision: "decline" }],
          createdAt: NOW,
        },
        readModel,
      } as never).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: expect.stringContaining("revision 10"),
      });
    }),
  );

  it.effect("rejects the whole batch when any approval is not pending", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.approval.batch-respond",
          commandId: CommandId.make("cmd-invalid-batch"),
          threadId: ThreadId.make("thread-1"),
          responses: [
            { requestId: ApprovalRequestId.make("approval-1"), decision: "accept" },
            { requestId: ApprovalRequestId.make("approval-missing"), decision: "accept" },
          ],
          createdAt: NOW,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
