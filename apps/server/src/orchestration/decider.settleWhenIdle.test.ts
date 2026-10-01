import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const session = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: THREAD_ID,
  status,
  providerName: "Codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
});

const readModel = (thread: Partial<OrchestrationThread> = {}): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      settleWhenIdleAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: session("running"),
      ...thread,
    },
  ],
  updatedAt: NOW,
});
const armed = (thread: Partial<OrchestrationThread> = {}) =>
  readModel({ settleWhenIdleAt: NOW, ...thread });

/** Decides the command and returns the event types and the projected thread. */
const run = Effect.fn("run")(function* (
  command: OrchestrationCommand,
  model: OrchestrationReadModel,
) {
  const result = yield* decideOrchestrationCommand({ command, readModel: model });
  const events = Array.isArray(result) ? result : [result];
  let projected = model;
  for (const [index, event] of events.entries()) {
    projected = yield* projectEvent(projected, { ...event, sequence: index + 1 });
  }
  return { types: events.map((event) => event.type), thread: projected.threads[0]! };
});

const commandId = (name: string) => CommandId.make(`cmd-${name}`);
const settleWhenIdle = {
  type: "thread.settle-when-idle",
  commandId: commandId("settle-when-idle"),
  threadId: THREAD_ID,
} as const;
const approvalRequest = {
  id: EventId.make("activity-approval"),
  tone: "approval" as const,
  kind: "approval.requested",
  summary: "Approval requested",
  payload: { requestId: "req-1" },
  turnId: null,
  createdAt: NOW,
};
const sessionSet = (status: OrchestrationSession["status"]): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: commandId(`session-${status}`),
  threadId: THREAD_ID,
  session: session(status),
  createdAt: NOW,
});

it.layer(NodeServices.layer)("thread.settle-when-idle decider", (it) => {
  it.effect("files a working thread away without settling it", () =>
    Effect.gen(function* () {
      const { types, thread } = yield* run(
        settleWhenIdle,
        readModel({ pinnedAt: NOW, snoozedUntil: "2026-02-01T00:00:00.000Z" }),
      );
      expect(types).toEqual(["thread.settle-when-idle-set", "thread.unpinned", "thread.unsnoozed"]);
      expect(thread.settleWhenIdleAt).not.toBeNull();
      expect(thread.settledOverride).toBeNull();

      // An agent waiting on the user must stay in view.
      const error = yield* decideOrchestrationCommand({
        command: settleWhenIdle,
        readModel: readModel({ activities: [approvalRequest] }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationThreadSettleBlockedError");
    }),
  );

  it.effect("the turn keeps the intent and the real settle clears it", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running", "ready"] as const) {
        expect((yield* run(sessionSet(status), armed())).types).toEqual(["thread.session-set"]);
      }
      // The reactor's settle, which the per-thread auto-settle opt-out does not block.
      const { thread } = yield* run(
        {
          type: "thread.auto-settle",
          commandId: commandId("settle"),
          threadId: THREAD_ID,
          snapshotSequence: 0,
          settledAt: NOW,
        },
        armed({ session: session("ready"), autoSettleDisabledAt: NOW }),
      );
      expect(thread.settledOverride).toBe("settled");
      expect(thread.settleWhenIdleAt).toBeNull();
    }),
  );

  it.effect("a message, a request, a failure, un-settle, and pin cancel it", () =>
    Effect.gen(function* () {
      const cancelling: ReadonlyArray<OrchestrationCommand> = [
        {
          type: "thread.turn.start",
          commandId: commandId("turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "One more thing",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        {
          type: "thread.activity.append",
          commandId: commandId("approval"),
          threadId: THREAD_ID,
          activity: approvalRequest,
          createdAt: NOW,
        },
        sessionSet("error"),
        {
          type: "thread.unsettle",
          commandId: commandId("unsettle"),
          threadId: THREAD_ID,
          reason: "user",
        },
        { type: "thread.pin", commandId: commandId("pin"), threadId: THREAD_ID },
      ];
      for (const command of cancelling) {
        const { types, thread } = yield* run(command, armed());
        expect(thread.settleWhenIdleAt).toBeNull();
        // Cancelling never stops the session.
        expect(types).not.toContain("thread.session-stop-requested");
      }
    }),
  );

  it.effect("finishes an explicit settle after un-settle and re-settle during one turn", () =>
    Effect.gen(function* () {
      const unsettled = yield* run(
        {
          type: "thread.unsettle",
          commandId: commandId("unsettle"),
          threadId: THREAD_ID,
          reason: "user",
        },
        armed(),
      );
      expect(unsettled.thread.settledOverride).toBe("active");
      const rearmed = yield* run(settleWhenIdle, readModel(unsettled.thread));
      expect(rearmed.thread.settleWhenIdleAt).not.toBeNull();
      expect(rearmed.types).not.toContain("thread.settled");
      const ready = yield* run(sessionSet("ready"), readModel(rearmed.thread));
      const command = {
        type: "thread.auto-settle",
        commandId: commandId("finish-rearmed"),
        threadId: THREAD_ID,
        snapshotSequence: 0,
        settledAt: NOW,
      } as const;
      const settled = yield* run(command, readModel(ready.thread));
      expect(settled.thread.settledOverride).toBe("settled");
      expect(settled.thread.settleWhenIdleAt).toBeNull();
      // A cancelled intent cannot override keep-active, and an already-settled thread stays guarded.
      for (const thread of [
        { ...ready.thread, settleWhenIdleAt: null },
        { ...ready.thread, settledOverride: "settled" as const },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: readModel(thread),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
