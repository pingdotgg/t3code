import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, openRequests, projectEvent } from "./projector.ts";

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
        pullRequests: [],
        branchPullRequest: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        activeOrderKey: null,
        autoSettleDisabledAt: null,
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
        {
          ...createEmptyReadModel(now),
          projects: [
            {
              id: ProjectId.make("project-1"),
              title: "T3 Code",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              repositoryIdentity: {
                canonicalKey: "github.com/pingdotgg/t3code",
                provider: "github",
                displayName: "pingdotgg/t3code",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "https://github.com/pingdotgg/t3code.git",
                },
              },
            },
          ],
        },
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

  effectIt.effect("keeps only user messages and request activities in the command model", () =>
    Effect.gen(function* () {
      const threadId = "thread-slim";
      const at = (second: number) => `2026-02-23T09:00:${String(second).padStart(2, "0")}.000Z`;
      const event = (sequence: number, type: OrchestrationEvent["type"], payload: object) =>
        makeEvent({
          sequence,
          type,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at(sequence),
          commandId: `cmd-${sequence}`,
          payload: { threadId, ...payload },
        });
      const message = (id: string, role: "user" | "assistant") => ({
        messageId: id,
        role,
        text: `${role} text`,
        turnId: null,
        streaming: false,
        createdAt: at(0),
        updatedAt: at(0),
      });
      const activity = (id: string, kind: string, payload: object) => ({
        activity: {
          id,
          tone: "tool",
          kind,
          summary: kind,
          payload,
          turnId: null,
          createdAt: at(0),
        },
      });

      const events = [
        event(1, "thread.created", {
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.3-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: at(0),
          updatedAt: at(0),
        }),
        event(2, "thread.message-sent", message("user-1", "user")),
        event(3, "thread.message-sent", message("assistant:1", "assistant")),
        event(
          4,
          "thread.activity-appended",
          activity("approval-1", "approval.requested", {
            requestId: "request-1",
          }),
        ),
        event(5, "thread.turn-diff-completed", {
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-slim/turn/1",
          status: "ready",
          files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
          assistantMessageId: "assistant:1",
          completedAt: at(5),
        }),
        event(
          6,
          "thread.activity-appended",
          activity("tool-1", "tool.completed", {
            data: { output: "x".repeat(10_000) },
          }),
        ),
        // Carries a requestId, but openRequests does not read this kind.
        event(
          7,
          "thread.activity-appended",
          activity("answer-1", "user-input.answer-submitted", {
            requestId: "request-2",
            answers: { q1: "yes" },
          }),
        ),
      ];
      let model = createEmptyReadModel(at(0));
      for (const next of events) {
        model = yield* projectEvent(model, next);
      }

      const thread = model.threads[0];
      expect(thread?.messages.map((entry) => entry.id)).toEqual(["user-1"]);
      expect(thread?.activities.map((entry) => entry.id)).toEqual(["approval-1"]);
      expect(thread?.checkpoints.map((entry) => [entry.turnId, entry.files])).toEqual([
        ["turn-1", []],
      ]);
      // Dropped events still move updatedAt, which the decider re-emits.
      expect(thread?.updatedAt).toBe(at(7));
    }),
  );

  effectIt.effect("keeps open requests past the activity cap", () =>
    Effect.gen(function* () {
      const threadId = "thread-requests";
      const createdAt = "2026-02-23T09:00:00.000Z";
      let sequence = 0;
      const event = (type: OrchestrationEvent["type"], payload: object) =>
        makeEvent({
          sequence: ++sequence,
          type,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: `cmd-${sequence}`,
          payload: { threadId, ...payload },
        });
      const activity = (kind: string, payload: object) =>
        event("thread.activity-appended", {
          activity: {
            id: `activity-${sequence + 1}`,
            tone: "approval",
            kind,
            summary: kind,
            payload,
            turnId: null,
            sequence: sequence + 1,
            createdAt,
          },
        });

      const events = [
        event("thread.created", {
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.3-codex" },
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        }),
        activity("approval.requested", { requestId: "open" }),
        activity("approval.requested", { requestId: "stale" }),
        activity("provider.approval.respond.failed", {
          requestId: "stale",
          detail: "Stale pending approval request: stale",
        }),
        ...Array.from({ length: 300 }, (_, index) => [
          activity("approval.requested", { requestId: `later-${index}` }),
          activity("approval.resolved", { requestId: `later-${index}` }),
        ]).flat(),
      ];
      let model = createEmptyReadModel(createdAt);
      for (const next of events) {
        model = yield* projectEvent(model, next);
      }

      const activities = model.threads[0]?.activities ?? [];
      expect(activities).toHaveLength(501);
      expect([...openRequests(activities).keys()]).toEqual(["open"]);
    }),
  );

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
            tone: "approval",
            kind: "approval.requested",
            summary: "Edit file requested",
            payload: { requestId: "request-1" },
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
            tone: "approval",
            kind: "approval.requested",
            summary: "Edit file requested",
            payload: { requestId: "request-2" },
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
      [{ role: "user", text: "First edit" }],
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
        sequence: 4,
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
        sequence: 5,
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
    expect(thread?.messages).toEqual([]);
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
            role: "user",
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
