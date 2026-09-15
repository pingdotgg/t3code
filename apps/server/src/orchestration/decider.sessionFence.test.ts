import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type ProviderSessionFence,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-09-08T00:00:00.000Z";
const threadId = ThreadId.make("thread");
const expectedSession: ProviderSessionFence = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "generation-1",
  activeTurnId: null,
  readiness: "ready",
};
const session: OrchestrationSession = {
  threadId,
  providerInstanceId: expectedSession.providerInstanceId,
  providerSessionId: expectedSession.providerSessionId,
  status: "ready",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};
const model = (current: OrchestrationSession = session): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  updatedAt: now,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Work",
      modelSelection: { instanceId: expectedSession.providerInstanceId, model: "gpt" },
      runtimeMode: "full-access",
      interactionMode: "default",
      pullRequests: [],
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: current,
    },
  ],
});
const start = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("conditional"),
  threadId,
  expectedSession,
  message: {
    messageId: MessageId.make("selected"),
    role: "user" as const,
    text: "Use the selected skill",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: now,
};

it.layer(NodeServices.layer)("conditional command acceptance", (it) => {
  for (const responseMode of [undefined, "message"] as const) {
    it.effect(`handles pending questions with response mode ${responseMode ?? "callback"}`, () =>
      Effect.gen(function* () {
        const current = model();
        const readModel = {
          ...current,
          threads: current.threads.map((thread) => ({
            ...thread,
            activities: [
              {
                id: EventId.make("pending-question"),
                tone: "info" as const,
                kind: "user-input.requested",
                summary: "Question",
                payload: { requestId: "question", ...(responseMode ? { responseMode } : {}) },
                turnId: null,
                createdAt: now,
              },
            ],
          })),
        };
        const result = yield* decideOrchestrationCommand({ command: start, readModel }).pipe(
          Effect.result,
        );
        expect(result._tag).toBe(responseMode === "message" ? "Success" : "Failure");
      }),
    );
  }
  it.effect("persists the exact expected session in the accepted intent", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({ command: start, readModel: model() });
      const events = Array.isArray(result) ? result : [result];
      expect(
        events.find((event) => event.type === "thread.turn-start-requested")?.payload,
      ).toMatchObject({ expectedSession });
    }),
  );
  it.effect(
    "rejects replacement, busy, missing identity and different provider before emitting a message",
    () =>
      Effect.gen(function* () {
        for (const changed of [
          { ...session, providerSessionId: "generation-2" },
          { ...session, status: "running" as const, activeTurnId: TurnId.make("running") },
          { ...session, providerSessionId: undefined },
          { ...session, providerInstanceId: ProviderInstanceId.make("claude") },
        ]) {
          const error = yield* decideOrchestrationCommand({
            command: start,
            readModel: model(changed),
          }).pipe(Effect.flip);
          expect(error._tag).toBe("OrchestrationCommandInvariantError");
        }
      }),
  );
  it.effect("preserves ordinary busy-thread steering without a condition", () =>
    Effect.gen(function* () {
      const { expectedSession: _condition, ...ordinary } = start;
      const result = yield* decideOrchestrationCommand({
        command: ordinary,
        readModel: model({ ...session, status: "running", activeTurnId: TurnId.make("busy") }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
    }),
  );
  it.effect("rejects an interrupt for a superseded turn and persists the matching condition", () =>
    Effect.gen(function* () {
      const currentTurn = TurnId.make("active");
      const current = model({ ...session, status: "running", activeTurnId: currentTurn });
      const interrupt = {
        type: "thread.turn.interrupt" as const,
        commandId: CommandId.make("interrupt"),
        threadId,
        expectedSession: {
          ...expectedSession,
          readiness: "running" as const,
          activeTurnId: currentTurn,
        },
        turnId: currentTurn,
        createdAt: now,
      };
      const accepted = yield* decideOrchestrationCommand({
        command: interrupt,
        readModel: current,
      });
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events[0]?.payload).toMatchObject({ expectedSession: interrupt.expectedSession });
      const rejected = yield* decideOrchestrationCommand({
        command: {
          ...interrupt,
          expectedSession: { ...interrupt.expectedSession, activeTurnId: TurnId.make("old") },
        },
        readModel: current,
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      const differentTarget = yield* decideOrchestrationCommand({
        command: { ...interrupt, turnId: TurnId.make("other") },
        readModel: current,
      }).pipe(Effect.flip);
      expect(differentTarget._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
