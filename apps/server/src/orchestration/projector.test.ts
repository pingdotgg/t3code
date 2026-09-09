import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { decideOrchestrationCommand } from "./decider.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        branchPullRequest: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        activeOrderKey: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ]);
  });

  effectIt.effect("sets and clears branch pull requests without changing manual links", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const eventFields = {
        aggregateKind: "thread" as const,
        aggregateId: "thread-1",
        occurredAt: now,
        commandId: null,
      };
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          ...eventFields,
          sequence: 1,
          type: "thread.created",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "Pull request thread",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            branch: "feature",
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      const linkedPullRequest = {
        projectId: "project-1",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
      };
      const branchPullRequest = {
        ...linkedPullRequest,
        number: 43,
        url: "https://github.com/pingdotgg/t3code/pull/43",
      };
      const updates = [
        { payload: { linkedPullRequest, branchPullRequest }, expected: branchPullRequest },
        { payload: { title: "Renamed thread" }, expected: branchPullRequest },
        { payload: { branchPullRequest: null }, expected: null },
      ];

      for (const [index, update] of updates.entries()) {
        model = yield* projectEvent(
          model,
          makeEvent({
            ...eventFields,
            sequence: index + 2,
            type: "thread.meta-updated",
            payload: { threadId: "thread-1", updatedAt: now, ...update.payload },
          }),
        );
        expect(model.threads[0]?.branchPullRequest).toEqual(update.expected);
        expect(model.threads[0]?.linkedPullRequest).toEqual(linkedPullRequest);
      }
    }),
  );

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T00:00:01.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  effectIt.effect.each([
    ["ready", "completed"],
    ["interrupted", "interrupted"],
  ] as const)(
    "preserves the turn state after a %s session captures its checkpoint",
    ([status, state]) =>
      Effect.gen(function* () {
        const createdAt = "2026-02-23T08:00:00.000Z";
        const startedAt = "2026-02-23T08:00:05.000Z";
        const model = createEmptyReadModel(createdAt);

        const afterCreate = yield* projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: createdAt,
            commandId: "cmd-create",
            payload: {
              threadId: "thread-1",
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5.3-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt,
              updatedAt: createdAt,
            },
          }),
        );

        const settledAt = "2026-02-23T08:01:00.000Z";
        const [afterRunning, afterReady] = yield* Effect.flatMap(
          projectEvent(
            afterCreate,
            makeEvent({
              sequence: 2,
              type: "thread.session-set",
              aggregateKind: "thread",
              aggregateId: "thread-1",
              occurredAt: startedAt,
              commandId: "cmd-running",
              payload: {
                threadId: "thread-1",
                session: {
                  threadId: "thread-1",
                  status: "running",
                  providerName: "codex",
                  providerSessionId: "session-1",
                  providerThreadId: "provider-thread-1",
                  runtimeMode: "approval-required",
                  activeTurnId: "turn-1",
                  lastError: null,
                  updatedAt: startedAt,
                },
              },
            }),
          ),
          (running) =>
            Effect.map(
              projectEvent(
                running,
                makeEvent({
                  sequence: 3,
                  type: "thread.session-set",
                  aggregateKind: "thread",
                  aggregateId: "thread-1",
                  occurredAt: settledAt,
                  commandId: "cmd-ready",
                  payload: {
                    threadId: "thread-1",
                    session: {
                      threadId: "thread-1",
                      status,
                      providerName: "codex",
                      providerSessionId: "session-1",
                      providerThreadId: "provider-thread-1",
                      runtimeMode: "approval-required",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: settledAt,
                    },
                  },
                }),
              ),
              (ready) => [running, ready] as const,
            ),
        );

        const thread = afterRunning.threads[0];
        expect(thread?.latestTurn?.turnId).toBe("turn-1");
        expect(thread?.session?.status).toBe("running");

        // Leaving the "running" session status settles the running turn with the
        // session timestamp as the turn end.
        const settledThread = afterReady.threads[0];
        expect(settledThread?.latestTurn?.turnId).toBe("turn-1");
        expect(settledThread?.latestTurn?.state).toBe(state);
        expect(settledThread?.latestTurn?.completedAt).toBe(settledAt);

        const captured = yield* projectEvent(
          afterReady,
          makeEvent({
            sequence: 4,
            type: "thread.turn-diff-completed",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: settledAt,
            commandId: "cmd-final-checkpoint",
            payload: {
              threadId: "thread-1",
              turnId: "turn-1",
              checkpointTurnCount: 1,
              checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
              status: "ready",
              files: [],
              assistantMessageId: "assistant:turn-1",
              completedAt: settledAt,
            },
          }),
        );
        expect(captured.threads[0]?.latestTurn?.state).toBe(state);
        expect(captured.threads[0]?.checkpoints[0]?.status).toBe("ready");
      }),
  );

  effectIt.effect.each([null, "ready", "interrupted", "stopped"] as const)(
    "replaces a missing checkpoint without inventing interruption for a %s session",
    (sessionStatus) =>
      Effect.gen(function* () {
        const now = "2026-09-04T23:00:00.000Z";
        const threadId = "thread-placeholder";
        const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
          makeEvent({
            sequence,
            type,
            payload,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: `placeholder-${sequence}`,
          });
        let model = yield* projectEvent(
          createEmptyReadModel(now),
          event(1, "thread.created", {
            threadId,
            projectId: "project-1",
            title: "Placeholder",
            modelSelection: { instanceId: "codex", model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          }),
        );
        const checkpoint = {
          threadId,
          turnId: "turn-placeholder",
          checkpointTurnCount: 1,
          checkpointRef: "provider-diff:placeholder",
          files: [],
          assistantMessageId: "assistant:placeholder",
          completedAt: now,
        };
        if (sessionStatus === "interrupted" || sessionStatus === "stopped") {
          model = yield* projectEvent(
            model,
            event(2, "thread.session-set", {
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: "turn-placeholder",
                lastError: null,
                updatedAt: now,
              },
            }),
          );
        }
        model = yield* projectEvent(
          model,
          event(3, "thread.turn-diff-completed", {
            ...checkpoint,
            status: "missing",
          }),
        );
        if (sessionStatus !== null) {
          model = yield* projectEvent(
            model,
            event(4, "thread.session-set", {
              threadId,
              session: {
                threadId,
                status: sessionStatus,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
            }),
          );
        }
        model = yield* projectEvent(
          model,
          event(5, "thread.turn-diff-completed", {
            ...checkpoint,
            status: "ready",
            checkpointRef: "refs/t3/checkpoints/thread-placeholder/turn/1",
          }),
        );
        expect(model.threads[0]?.latestTurn?.state).toBe(
          sessionStatus === "interrupted" || sessionStatus === "stopped"
            ? "interrupted"
            : "completed",
        );
      }),
  );

  effectIt.effect("does not let a stale terminal session clear a newer pending turn", () =>
    Effect.gen(function* () {
      const now = "2026-09-07T23:00:00.000Z";
      const threadId = "thread-stale-terminal";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `stale-terminal-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Stale terminal",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      for (const [index, messageId] of ["older-request", "newer-request"].entries()) {
        model = yield* projectEvent(
          model,
          event(index + 2, "thread.turn-start-requested", {
            threadId,
            messageId,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          }),
        );
      }
      model = yield* projectEvent(
        model,
        event(4, "thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "older request failed",
            updatedAt: now,
          },
        }),
      );

      expect(model.threads[0]?.pendingTurnStartMessageId).toBe("newer-request");
    }),
  );

  effectIt.effect("keeps acknowledged starts guarded until their provider turn is running", () =>
    Effect.gen(function* () {
      const now = "2026-09-07T23:30:00.000Z";
      const threadId = "thread-correlated-start-acknowledgement";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `correlated-start-acknowledgement-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Correlated acknowledgement",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      model = yield* projectEvent(
        model,
        event(2, "thread.turn-start-requested", {
          threadId,
          messageId: "newer-request",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        }),
      );
      model = yield* projectEvent(
        model,
        event(3, "thread.meta-updated", {
          threadId,
          turnStartAcknowledged: {
            messageId: "older-request",
            turnId: "turn-provider-acknowledged",
          },
          updatedAt: now,
        }),
      );
      expect(model.threads[0]?.pendingTurnStartMessageId).toBe("newer-request");
      expect(model.threads[0]?.submittedTurnStarts).toEqual([
        {
          messageId: "older-request",
          turnId: "turn-provider-acknowledged",
        },
      ]);

      model = yield* projectEvent(
        model,
        event(4, "thread.meta-updated", {
          threadId,
          turnStartAcknowledged: {
            messageId: "newer-request",
            turnId: "turn-provider-acknowledged",
          },
          updatedAt: now,
        }),
      );
      expect(model.threads[0]?.pendingTurnStartMessageId).toBe("newer-request");
      expect(model.threads[0]?.submittedTurnStarts).toEqual([
        {
          messageId: "older-request",
          turnId: "turn-provider-acknowledged",
        },
        {
          messageId: "newer-request",
          turnId: "turn-provider-acknowledged",
        },
      ]);

      model = yield* projectEvent(
        model,
        event(5, "thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-provider-acknowledged",
            lastError: null,
            updatedAt: now,
          },
        }),
      );
      expect(model.threads[0]?.pendingTurnStartMessageId).toBeNull();
      expect(model.threads[0]?.submittedTurnStarts).toEqual([]);

      model = yield* projectEvent(
        model,
        event(6, "thread.turn-start-requested", {
          threadId,
          messageId: "steering-request",
          expectsTurnStartAcknowledgement: true,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        }),
      );
      model = yield* projectEvent(
        model,
        event(7, "thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
      );
      model = yield* projectEvent(
        model,
        event(8, "thread.meta-updated", {
          threadId,
          turnStartAcknowledged: {
            messageId: "steering-request",
            turnId: "turn-provider-acknowledged",
          },
          updatedAt: now,
        }),
      );
      expect(model.threads[0]?.pendingTurnStartMessageId).toBeNull();
      expect(model.threads[0]?.submittedTurnStarts).toEqual([]);
      expect(model.threads[0]?.turnStartSubmissionRendezvous).toBeNull();
    }),
  );

  effectIt.effect("does not re-guard a turn acknowledged after its lifecycle was observed", () =>
    Effect.gen(function* () {
      const now = "2026-09-08T01:50:00.000Z";
      const threadId = "thread-late-start-acknowledgement";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `late-start-acknowledgement-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Late start acknowledgement",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      model = yield* projectEvent(
        model,
        event(2, "thread.turn-start-requested", {
          threadId,
          messageId: "request-a",
          expectsTurnStartAcknowledgement: true,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        }),
      );
      for (const [sequence, status, activeTurnId] of [
        [3, "running", "turn-a"],
        [4, "ready", null],
      ] as const) {
        model = yield* projectEvent(
          model,
          event(sequence, "thread.session-set", {
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId,
              lastError: null,
              updatedAt: now,
            },
          }),
        );
      }
      model = yield* projectEvent(
        model,
        event(5, "thread.turn-start-requested", {
          threadId,
          messageId: "request-b",
          expectsTurnStartAcknowledgement: true,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        }),
      );
      model = yield* projectEvent(
        model,
        event(6, "thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-b",
            lastError: null,
            updatedAt: now,
          },
        }),
      );
      model = yield* projectEvent(
        model,
        event(7, "thread.meta-updated", {
          threadId,
          turnStartAcknowledged: { messageId: "request-a", turnId: "turn-a" },
          updatedAt: now,
        }),
      );

      expect(model.threads[0]?.pendingTurnStartMessageId).toBeNull();
      expect(model.threads[0]?.submittedTurnStarts).toEqual([]);
      expect(model.threads[0]?.turnStartSubmissionRendezvous).toEqual({
        requests: [{ messageId: "request-b", observedTurnIds: ["turn-b"] }],
      });
      model = yield* projectEvent(
        model,
        event(8, "thread.activity-appended", {
          threadId,
          activity: {
            id: "request-b-failed",
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { requestId: "request-b" },
            turnId: null,
            createdAt: now,
          },
        }),
      );
      expect(model.threads[0]?.turnStartSubmissionRendezvous).toBeNull();
    }),
  );

  effectIt.effect("clears only the submitted start correlated to a provider failure", () =>
    Effect.gen(function* () {
      const now = "2026-09-08T04:30:00.000Z";
      const threadId = "thread-correlated-submitted-failure";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `correlated-submitted-failure-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Correlated submitted failure",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      for (const [sequence, messageId, turnId] of [
        [2, "request-a", "turn-a"],
        [3, "request-b", "turn-b"],
      ] as const) {
        model = yield* projectEvent(
          model,
          event(sequence, "thread.meta-updated", {
            threadId,
            turnStartAcknowledged: { messageId, turnId },
            updatedAt: now,
          }),
        );
      }

      model = yield* projectEvent(
        model,
        event(4, "thread.activity-appended", {
          threadId,
          activity: {
            id: "request-a-failed",
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { requestId: "request-a" },
            turnId: "turn-a",
            createdAt: now,
          },
        }),
      );

      expect(model.threads[0]?.submittedTurnStarts).toEqual([
        { messageId: "request-b", turnId: "turn-b" },
      ]);
    }),
  );

  effectIt.effect("does not enroll legacy turn history in submission rendezvous state", () =>
    Effect.gen(function* () {
      const now = "2026-09-08T01:55:00.000Z";
      const threadId = "thread-legacy-start-history";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `legacy-start-history-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Legacy start history",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      for (let turn = 1; turn <= 3; turn += 1) {
        const baseSequence = turn * 3 - 1;
        model = yield* projectEvent(
          model,
          event(baseSequence, "thread.turn-start-requested", {
            threadId,
            messageId: `legacy-request-${turn}`,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          }),
        );
        for (const [offset, status, activeTurnId] of [
          [1, "running", `legacy-turn-${turn}`],
          [2, "ready", null],
        ] as const) {
          model = yield* projectEvent(
            model,
            event(baseSequence + offset, "thread.session-set", {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId,
                lastError: null,
                updatedAt: now,
              },
            }),
          );
        }
      }

      expect(model.threads[0]?.turnStartSubmissionRendezvous).toBeNull();
    }),
  );

  effectIt.effect(
    "matches every acknowledgement when concurrent starts share a provider turn",
    () =>
      Effect.gen(function* () {
        const now = "2026-09-08T02:30:00.000Z";
        const threadId = "thread-shared-provider-turn";
        const providerTurnId = "turn-shared-provider";
        const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
          makeEvent({
            sequence,
            type,
            payload,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: `shared-provider-turn-${sequence}`,
          });
        type Step = "request-a" | "request-b" | "ack-a" | "ack-b" | "running" | "terminal";
        const permutations = (steps: readonly Step[]): Step[][] =>
          steps.length === 0
            ? [[]]
            : steps.flatMap((step, index) =>
                permutations(steps.filter((_, candidateIndex) => candidateIndex !== index)).map(
                  (tail) => [step, ...tail],
                ),
              );
        const orders = permutations([
          "request-a",
          "request-b",
          "ack-a",
          "ack-b",
          "running",
          "terminal",
        ]).filter(
          (order) =>
            order.indexOf("request-a") < order.indexOf("ack-a") &&
            order.indexOf("request-b") < order.indexOf("ack-b") &&
            order.indexOf("running") < order.indexOf("terminal") &&
            order.indexOf("request-a") < order.indexOf("terminal") &&
            order.indexOf("request-b") < order.indexOf("terminal"),
        );
        expect(orders).toHaveLength(66);

        for (const [caseIndex, order] of orders.entries()) {
          let sequence = 1;
          let model = yield* projectEvent(
            createEmptyReadModel(now),
            event(sequence, "thread.created", {
              threadId,
              projectId: "project-1",
              title: "Shared provider turn",
              modelSelection: { instanceId: "claude", model: "test" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
          for (const [stepIndex, step] of order.entries()) {
            sequence += 1;
            if (step === "request-a" || step === "request-b") {
              const messageId = step === "request-a" ? "request-a" : "request-b";
              model = yield* projectEvent(
                model,
                event(sequence, "thread.turn-start-requested", {
                  threadId,
                  messageId,
                  expectsTurnStartAcknowledgement: true,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: now,
                }),
              );
            } else if (step === "ack-a" || step === "ack-b") {
              const messageId = step === "ack-a" ? "request-a" : "request-b";
              model = yield* projectEvent(
                model,
                event(sequence, "thread.meta-updated", {
                  threadId,
                  turnStartAcknowledged: { messageId, turnId: providerTurnId },
                  updatedAt: now,
                }),
              );
            } else {
              const running = step === "running";
              model = yield* projectEvent(
                model,
                event(sequence, "thread.session-set", {
                  threadId,
                  session: {
                    threadId,
                    status: running ? "running" : "ready",
                    providerName: "claude",
                    runtimeMode: "full-access",
                    activeTurnId: running ? providerTurnId : null,
                    lastError: null,
                    updatedAt: now,
                  },
                }),
              );
            }

            const revert = decideOrchestrationCommand({
              command: {
                type: "thread.checkpoint.revert",
                commandId: CommandId.make(`shared-turn-revert-${caseIndex}-${sequence}`),
                threadId: ThreadId.make(threadId),
                turnCount: 0,
                createdAt: now,
              },
              readModel: model,
            }).pipe(Effect.provide(NodeServices.layer));
            if (stepIndex < order.length - 1) {
              const error = yield* revert.pipe(Effect.flip);
              expect(error._tag).toBe("OrchestrationCommandInvariantError");
            } else {
              const result = yield* revert;
              const events = Array.isArray(result) ? result : [result];
              expect(events[0]?.type).toBe("thread.checkpoint-revert-requested");
            }
          }

          expect(model.threads[0]?.pendingTurnStartMessageId).toBeNull();
          expect(model.threads[0]?.submittedTurnStarts).toEqual([]);
          expect(model.threads[0]?.turnStartSubmissionRendezvous).toBeNull();
        }
      }),
  );

  effectIt.effect("keeps queued messages reserved when one of consecutive reverts fails", () =>
    Effect.gen(function* () {
      const now = "2026-09-08T00:00:00.000Z";
      const threadId = "thread-consecutive-revert-failure";
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
        makeEvent({
          sequence,
          type,
          payload,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: `consecutive-revert-${sequence}`,
        });
      let model = yield* projectEvent(
        createEmptyReadModel(now),
        event(1, "thread.created", {
          threadId,
          projectId: "project-1",
          title: "Consecutive revert failure",
          modelSelection: { instanceId: "codex", model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      for (const sequence of [2, 3]) {
        model = yield* projectEvent(
          model,
          event(sequence, "thread.checkpoint-revert-requested", {
            threadId,
            turnCount: 0,
            createdAt: now,
          }),
        );
      }
      for (const [index, messageId] of ["queued-1", "queued-2"].entries()) {
        model = yield* projectEvent(
          model,
          event(index + 4, "thread.turn-start-requested", {
            threadId,
            messageId,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          }),
        );
      }
      model = yield* projectEvent(
        model,
        event(6, "thread.activity-appended", {
          threadId,
          activity: {
            id: "revert-failed-1",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            tone: "error",
            turnId: null,
            createdAt: now,
            payload: { detail: "first revert failed" },
          },
        }),
      );

      expect(model.threads[0]?.pendingCheckpointRevertCount).toBe(1);
      expect(model.threads[0]?.pendingCheckpointRevertMessageIds).toEqual(["queued-1", "queued-2"]);
    }),
  );

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });
});
