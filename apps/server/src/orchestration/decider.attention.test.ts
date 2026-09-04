import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

function makeReadModel(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
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
        attention: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      },
    ],
    updatedAt: NOW,
  };
}

const decide = (command: OrchestrationCommand, readModel = makeReadModel()) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((result) => (Array.isArray(result) ? result : [result])),
  );

it.layer(NodeServices.layer)("thread attention decider", (it) => {
  it.effect("sets question attention and wakes settled and snoozed threads", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "thread.attention.set",
          commandId: CommandId.make("attention-set"),
          threadId,
          attention: { kind: "question", raisedAt: NOW },
          createdAt: NOW,
        },
        makeReadModel({
          settledOverride: "settled",
          settledAt: NOW,
          snoozedUntil: "2026-01-02T00:00:00.000Z",
          snoozedAt: NOW,
        }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.attention-set",
      ]);
    }),
  );

  it.effect("clears question attention after the user's reply and before turn start", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("turn-start"),
          threadId,
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "My answer",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        makeReadModel({ attention: { kind: "question", raisedAt: NOW } }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.attention-cleared",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("manual settle dismisses attention but automatic settle is blocked", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        attention: { kind: "question", raisedAt: NOW },
      });
      const manualEvents = yield* decide(
        {
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId,
        },
        readModel,
      );
      expect(manualEvents.map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.attention-cleared",
      ]);

      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-settle",
          commandId: CommandId.make("auto-settle"),
          threadId,
          snapshotSequence: 0,
          settledAt: NOW,
        },
        readModel,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationThreadSettleBlockedError");
    }),
  );

  it.effect("does not snooze a thread that is waiting for an answer", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("snooze"),
          threadId,
          snoozedUntil: "1970-01-02T00:00:00.000Z",
        },
        readModel: makeReadModel({ attention: { kind: "question", raisedAt: NOW } }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clears question attention after reverting past the question", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "thread.revert.complete",
          commandId: CommandId.make("revert-complete"),
          threadId,
          turnCount: 1,
          createdAt: NOW,
        },
        makeReadModel({ attention: { kind: "question", raisedAt: NOW } }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.reverted",
        "thread.attention-cleared",
      ]);
    }),
  );

  it.effect("clears question attention when the user interrupts the turn", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("turn-interrupt"),
          threadId,
          createdAt: NOW,
        },
        makeReadModel({ attention: { kind: "question", raisedAt: NOW } }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-interrupt-requested",
        "thread.attention-cleared",
      ]);
    }),
  );

  it.effect("clears question attention on failed turns but preserves delivered questions", () =>
    Effect.gen(function* () {
      const session = {
        threadId,
        providerName: "Codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      };
      const readModel = makeReadModel({ attention: { kind: "question", raisedAt: NOW } });

      for (const status of ["error", "interrupted"] as const) {
        const events = yield* decide(
          {
            type: "thread.session.set",
            commandId: CommandId.make(`session-${status}`),
            threadId,
            session: { ...session, status },
            createdAt: NOW,
          },
          readModel,
        );
        expect(events.map((event) => event.type)).toEqual([
          "thread.session-set",
          "thread.attention-cleared",
        ]);
      }

      const readyEvents = yield* decide(
        {
          type: "thread.session.set",
          commandId: CommandId.make("session-ready"),
          threadId,
          session: { ...session, status: "ready" },
          createdAt: NOW,
        },
        readModel,
      );
      expect(readyEvents.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );
});
