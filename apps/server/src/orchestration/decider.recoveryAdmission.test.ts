import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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

const REQUESTED_AT = "2026-01-01T00:00:00.000Z";
const FAILED_AT = "2026-01-01T00:01:00.000Z";
const RECOVERED_AT = "2026-01-01T00:10:00.000Z";
const THREAD_ID = ThreadId.make("thread-recovery");
const TURN_ID = TurnId.make("turn-interrupted");

function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: status === "error" ? "Connection lost" : null,
    updatedAt: FAILED_AT,
  };
}

function readModel(patch: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 10,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-recovery"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: {
          turnId: TURN_ID,
          state: "error",
          requestedAt: REQUESTED_AT,
          startedAt: REQUESTED_AT,
          completedAt: FAILED_AT,
          assistantMessageId: null,
        },
        createdAt: REQUESTED_AT,
        updatedAt: FAILED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: session("error"),
        ...patch,
      },
    ],
    updatedAt: FAILED_AT,
  };
}

function recoveryCommand(
  expectedSnapshotSequence = 10,
): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  return {
    type: "thread.session.set",
    commandId: CommandId.make("cmd-recovery"),
    threadId: THREAD_ID,
    session: { ...session("starting"), updatedAt: RECOVERED_AT },
    recoveryAdmission: { interruptedTurnId: TURN_ID, expectedSnapshotSequence },
    createdAt: RECOVERED_AT,
  };
}

it.layer(NodeServices.layer)("connection-loss recovery admission", (it) => {
  it.effect(
    "reserves an eligible interruption once, even if a second worker refreshes its sequence",
    () =>
      Effect.gen(function* () {
        const initial = readModel();
        const result = yield* decideOrchestrationCommand({
          command: recoveryCommand(),
          readModel: initial,
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("thread.session-set");
        let reserved = initial;
        for (const event of events) {
          reserved = yield* projectEvent(reserved, {
            ...event,
            sequence: reserved.snapshotSequence + 1,
          });
        }
        expect(reserved.threads[0]?.session?.status).toBe("starting");
        const rejected = yield* decideOrchestrationCommand({
          command: {
            ...recoveryCommand(reserved.snapshotSequence),
            commandId: CommandId.make("cmd-second-recovery"),
          },
          readModel: reserved,
        }).pipe(Effect.flip);
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );

  it.effect("releases only the reservation the worker owns", () =>
    Effect.gen(function* () {
      const reserved = {
        ...readModel({
          session: { ...session("starting"), updatedAt: RECOVERED_AT },
        }),
        // Other threads can advance the stream while this reservation is held.
        snapshotSequence: 11,
      };
      const release = {
        ...recoveryCommand(),
        session: session("error"),
        recoveryAdmission: {
          interruptedTurnId: TURN_ID,
          expectedSnapshotSequence: 10,
          reservationUpdatedAt: RECOVERED_AT,
        },
      };
      const result = yield* decideOrchestrationCommand({ command: release, readModel: reserved });
      expect(result).toMatchObject({
        type: "thread.session-set",
        payload: { session: { status: "error" } },
      });
      const rejected = yield* decideOrchestrationCommand({
        command: {
          ...release,
          recoveryAdmission: { ...release.recoveryAdmission, reservationUpdatedAt: FAILED_AT },
        },
        readModel: reserved,
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  const ineligible: ReadonlyArray<readonly [string, Partial<OrchestrationThread>]> = [
    ["archived", { archivedAt: FAILED_AT }],
    ["deleted", { deletedAt: FAILED_AT }],
    ["settled", { settledOverride: "settled", settledAt: FAILED_AT }],
    ["session stopped", { session: session("stopped") }],
    ["session running", { session: session("running") }],
    ["active provider turn", { session: { ...session("error"), activeTurnId: TURN_ID } }],
    ...(["approval.requested", "user-input.requested"] as const).map(
      (kind): readonly [string, Partial<OrchestrationThread>] => [
        kind,
        {
          activities: [
            {
              id: EventId.make("request-event"),
              kind,
              tone: "approval",
              summary: "Waiting for user",
              payload: { requestId: "request-pending" },
              turnId: TURN_ID,
              createdAt: FAILED_AT,
            },
          ],
        },
      ],
    ),
    [
      "newer user work, even after the queue grace period",
      {
        messages: [
          {
            id: MessageId.make("message-newer"),
            role: "user",
            text: "A different task",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-01-01T00:02:00.000Z",
            updatedAt: "2026-01-01T00:02:00.000Z",
          },
        ],
      },
    ],
  ];
  for (const [name, patch] of ineligible) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const rejected = yield* decideOrchestrationCommand({
          command: recoveryCommand(),
          readModel: readModel(patch),
        }).pipe(Effect.flip);
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }),
    );
  }

  for (const state of ["completed", "interrupted", "running"] as const) {
    it.effect(`rejects a latest turn that became ${state}`, () =>
      Effect.gen(function* () {
        const initial = readModel();
        const latestTurn = initial.threads[0]!.latestTurn!;
        const rejected = yield* decideOrchestrationCommand({
          command: recoveryCommand(),
          readModel: readModel({ latestTurn: { ...latestTurn, state } }),
        }).pipe(Effect.flip);
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }),
    );
  }

  it.effect("rejects a different interrupted turn", () =>
    Effect.gen(function* () {
      const command = recoveryCommand();
      const rejected = yield* decideOrchestrationCommand({
        command: {
          ...command,
          recoveryAdmission: {
            interruptedTurnId: TurnId.make("turn-other"),
            expectedSnapshotSequence: 10,
          },
        },
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
