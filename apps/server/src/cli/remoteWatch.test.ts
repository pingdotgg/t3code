import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  formatRemoteWatchResult,
  observeRemoteWatchStream,
  RemoteWatchFailure,
  RemoteWatchInteractionRequiredError,
  RemoteWatchNoTurnError,
  RemoteWatchTerminalWithoutMessageError,
  RemoteWatchTimeoutError,
  selectFinalAssistantMessage,
  selectPendingRemoteWatchInteraction,
  type RemoteWatchTransport,
  watchRemoteThread,
} from "./remoteWatch.ts";

const threadId = ThreadId.make("thread-watch");
const turnId = TurnId.make("turn-watch");

const snapshot = (input: {
  readonly sequence: number;
  readonly status: OrchestrationSessionStatus;
  readonly messageTexts?: ReadonlyArray<{
    readonly text: string;
    readonly turnId?: TurnId;
    readonly streaming?: boolean;
  }>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
}): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: input.sequence,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-watch"),
      title: "Watch",
      modelSelection: { instanceId: "codex_personal", model: "gpt-test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feat/watch",
      worktreePath: "/repo/.worktrees/watch",
      latestTurn: {
        turnId,
        state:
          input.status === "running" || input.status === "starting"
            ? "running"
            : input.status === "interrupted"
              ? "interrupted"
              : input.status === "error"
                ? "error"
                : "completed",
        requestedAt: "2026-07-21T00:00:00.000Z",
        startedAt: "2026-07-21T00:00:01.000Z",
        completedAt: input.status === "running" ? null : "2026-07-21T00:01:00.000Z",
        assistantMessageId: null,
      },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:01:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: (input.messageTexts ?? []).map((message, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        text: message.text,
        turnId: message.turnId ?? turnId,
        streaming: message.streaming ?? false,
        createdAt: `2026-07-21T00:00:${String(index).padStart(2, "0")}.000Z`,
        updatedAt: `2026-07-21T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
      proposedPlans: [],
      activities: input.activities ?? [],
      checkpoints: [],
      session: {
        threadId,
        status: input.status,
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: input.status === "running" || input.status === "starting" ? turnId : null,
        lastError: input.status === "error" ? "failed" : null,
        updatedAt: "2026-07-21T00:01:00.000Z",
      },
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

const sessionEvent = (
  sequence: number,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null = status === "running" ? turnId : null,
): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      sequence,
      eventId: EventId.make(`event-${sequence}-${status}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-07-21T00:01:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status,
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId,
          lastError: status === "error" ? "failed" : null,
          updatedAt: "2026-07-21T00:01:00.000Z",
        },
      },
    },
  }) as OrchestrationThreadStreamItem;

const activity = (input: {
  readonly kind: string;
  readonly requestId: string;
  readonly payload?: Record<string, unknown>;
  readonly turnId?: TurnId | null;
  readonly sequence?: number;
  readonly createdAt?: string;
}): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${input.kind}-${input.requestId}-${input.sequence ?? 0}`),
  tone: input.kind.startsWith("approval") ? "approval" : "info",
  kind: input.kind,
  summary: "Interaction state changed",
  payload: { requestId: input.requestId, ...input.payload },
  turnId: input.turnId === undefined ? turnId : input.turnId,
  ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  createdAt: input.createdAt ?? "2026-07-21T00:00:10.000Z",
});

const activityEvent = (
  sequence: number,
  value: OrchestrationThreadActivity,
): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      sequence,
      eventId: EventId.make(`activity-event-${sequence}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: value.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: { threadId, activity: value },
    },
  }) as OrchestrationThreadStreamItem;

describe("remote thread watch", () => {
  it("detects pending user input with bounded non-secret prompt metadata", () => {
    const questions = Array.from({ length: 20 }, (_, index) => ({
      id: `question-${index}`,
      header: `secret header ${index}`,
      question: `secret prompt ${index}`,
      options: Array.from({ length: index + 1 }, (_unused, optionIndex) => ({
        label: `secret option ${optionIndex}`,
        description: `secret description ${optionIndex}`,
      })),
      multiSelect: index % 2 === 0,
    }));

    expect(
      selectPendingRemoteWatchInteraction(
        [
          activity({
            kind: "user-input.requested",
            requestId: "request-user-input-1",
            payload: { questions },
          }),
        ],
        turnId,
      ),
    ).toEqual({
      kind: "user-input",
      requestId: "request-user-input-1",
      prompt: {
        questionCount: 20,
        questions: Array.from({ length: 16 }, (_, index) => ({
          index,
          optionCount: index + 1,
          multiSelect: index % 2 === 0,
        })),
        questionsTruncated: true,
      },
    });
  });

  it("detects only pending command approvals", () => {
    const fileApproval = activity({
      kind: "approval.requested",
      requestId: "approval-file-1",
      payload: { requestKind: "file-change", detail: "unsafe file details" },
    });
    const commandApproval = activity({
      kind: "approval.requested",
      requestId: "approval-command-1",
      payload: {
        requestType: "exec_command_approval",
        detail: "unsafe command details",
      },
      createdAt: "2026-07-21T00:00:11.000Z",
    });

    expect(selectPendingRemoteWatchInteraction([fileApproval, commandApproval], turnId)).toEqual({
      kind: "approval",
      requestId: "approval-command-1",
      prompt: { requestKind: "command" },
    });
    expect(
      selectPendingRemoteWatchInteraction(
        [
          commandApproval,
          activity({
            kind: "approval.resolved",
            requestId: "approval-command-1",
            createdAt: "2026-07-21T00:00:12.000Z",
          }),
        ],
        turnId,
      ),
    ).toBeNull();
  });

  it("detects actionable requests without a provider turn id", () => {
    const pending = activity({
      kind: "user-input.requested",
      requestId: "user-input-null-turn",
      payload: { questions: [{ options: [] }] },
      turnId: null,
    });

    expect(selectPendingRemoteWatchInteraction([pending], turnId)).toMatchObject({
      kind: "user-input",
      requestId: "user-input-null-turn",
    });
  });

  it("clears only the exact pending request for a production-shaped null-turn stale failure", () => {
    const requested = activity({
      kind: "user-input.requested",
      requestId: "user-input-stale-null-turn",
      payload: { questions: [{ options: [] }] },
      sequence: 31,
      createdAt: "2026-07-21T00:00:10.000Z",
    });
    const unrelatedFailure = activity({
      kind: "provider.user-input.respond.failed",
      requestId: "different-user-input-request",
      payload: {
        detail:
          "Stale pending user-input request: different-user-input-request. Provider callback state does not survive app restarts or recovered sessions.",
      },
      turnId: null,
      createdAt: "2026-07-21T00:00:11.000Z",
    });
    const wrongKindFailure = activity({
      kind: "provider.approval.respond.failed",
      requestId: "user-input-stale-null-turn",
      payload: {
        detail:
          "Stale pending approval request: user-input-stale-null-turn. Provider callback state does not survive app restarts or recovered sessions.",
      },
      turnId: null,
      createdAt: "2026-07-21T00:00:12.000Z",
    });
    const exactFailure = activity({
      kind: "provider.user-input.respond.failed",
      requestId: "user-input-stale-null-turn",
      payload: {
        detail:
          "Stale pending user-input request: user-input-stale-null-turn. Provider callback state does not survive app restarts or recovered sessions.",
      },
      turnId: null,
      createdAt: "2026-07-21T00:00:13.000Z",
    });

    expect(
      selectPendingRemoteWatchInteraction([requested, unrelatedFailure, wrongKindFailure], turnId),
    ).toMatchObject({ kind: "user-input", requestId: "user-input-stale-null-turn" });
    expect(
      selectPendingRemoteWatchInteraction(
        [requested, unrelatedFailure, wrongKindFailure, exactFailure],
        turnId,
      ),
    ).toBeNull();
  });

  it("orders a same-turn unsequenced stale failure after its sequenced request", () => {
    const requested = activity({
      kind: "approval.requested",
      requestId: "approval-stale-unsequenced",
      payload: { requestKind: "command" },
      sequence: 41,
      createdAt: "2026-07-21T00:00:10.000Z",
    });
    const staleFailure = activity({
      kind: "provider.approval.respond.failed",
      requestId: "approval-stale-unsequenced",
      payload: {
        detail:
          "Stale pending approval request: approval-stale-unsequenced. Provider callback state does not survive app restarts or recovered sessions.",
      },
      createdAt: "2026-07-21T00:00:11.000Z",
    });

    expect(selectPendingRemoteWatchInteraction([requested, staleFailure], turnId)).toBeNull();
    expect(selectPendingRemoteWatchInteraction([staleFailure, requested], turnId)).toBeNull();
  });

  it("does not let an earlier sequenced stale failure clear a later request with the same ID", () => {
    const staleFailure = activity({
      kind: "provider.approval.respond.failed",
      requestId: "approval-retried",
      payload: {
        detail:
          "Stale pending approval request: approval-retried. Provider callback state does not survive app restarts or recovered sessions.",
      },
      sequence: 51,
      createdAt: "2026-07-21T00:00:12.000Z",
    });
    const retriedRequest = activity({
      kind: "approval.requested",
      requestId: "approval-retried",
      payload: { requestKind: "command" },
      sequence: 52,
      createdAt: "2026-07-21T00:00:11.000Z",
    });

    expect(
      selectPendingRemoteWatchInteraction([retriedRequest, staleFailure], turnId),
    ).toMatchObject({ kind: "approval", requestId: "approval-retried" });
  });

  it.effect("exits promptly for a pending user-input request when opted in", () =>
    Effect.gen(function* () {
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.succeed(
            snapshot({
              sequence: 10,
              status: "running",
              activities: [
                activity({
                  kind: "user-input.requested",
                  requestId: "request-user-input-watch",
                  payload: {
                    questions: [{ options: [{ label: "secret", description: "secret" }] }],
                  },
                }),
              ],
            }),
          ),
        subscribeThread: () => Effect.never,
      };

      const error = yield* watchRemoteThread({
        transport,
        threadId,
        timeoutMs: 10_000,
        interactionAware: true,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(RemoteWatchInteractionRequiredError);
      expect(error[Runtime.errorExitCode]).toBe(26);
      expect(error[Runtime.errorReported]).toBe(false);
      expect(error.message).toBe(
        '{"threadId":"thread-watch","turnId":"turn-watch","interaction":{"kind":"user-input","requestId":"request-user-input-watch","prompt":{"questionCount":1,"questions":[{"index":0,"optionCount":1,"multiSelect":false}],"questionsTruncated":false}}}',
      );
    }),
  );

  it.effect("exits promptly for a command approval arriving on the live stream", () =>
    Effect.gen(function* () {
      const pendingApproval = activity({
        kind: "approval.requested",
        requestId: "approval-command-watch",
        payload: {
          requestKind: "command",
          detail: "run secret-command --token=secret",
          command: "secret-command",
          argv: ["--token=secret"],
        },
      });
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(snapshot({ sequence: 10, status: "running" })),
        subscribeThread: (input) =>
          observeRemoteWatchStream({
            stream: Stream.fromIterable([activityEvent(11, pendingApproval)]),
            initialSequence: input.afterSequence,
            targetTurnId: input.targetTurnId,
            observedRunning: input.observedRunning,
            interactionAware: input.interactionAware,
          }),
      };

      const error = yield* watchRemoteThread({
        transport,
        threadId,
        timeoutMs: 10_000,
        interactionAware: true,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(RemoteWatchInteractionRequiredError);
      expect(error[Runtime.errorExitCode]).toBe(26);
      expect(error[Runtime.errorReported]).toBe(false);
      expect(error.message).toBe(
        '{"threadId":"thread-watch","turnId":"turn-watch","interaction":{"kind":"approval","requestId":"approval-command-watch","prompt":{"requestKind":"command"}}}',
      );
    }),
  );

  it.effect("a later watch skips a handled interaction and observes the final result", () =>
    Effect.gen(function* () {
      const requested = activity({
        kind: "user-input.requested",
        requestId: "request-user-input-handled",
        payload: { questions: [{ options: [] }] },
        sequence: 1,
      });
      const resolved = activity({
        kind: "user-input.resolved",
        requestId: "request-user-input-handled",
        sequence: 2,
        createdAt: "2026-07-21T00:00:11.000Z",
      });
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({
                  sequence: 12,
                  status: "running",
                  activities: [requested, resolved],
                })
              : snapshot({
                  sequence: 13,
                  status: "ready",
                  activities: [requested, resolved],
                  messageTexts: [{ text: "continued after answer" }],
                });
          }),
        subscribeThread: () =>
          Effect.succeed({ status: "ready", lastSequence: 13, observedRunning: true }),
      };

      const result = yield* watchRemoteThread({
        transport,
        threadId,
        timeoutMs: 10_000,
        interactionAware: true,
      });
      expect(result.message.text).toBe("continued after answer");
    }),
  );

  it.effect(
    "subsequent watches advance from a question to approval and then the final result",
    () =>
      Effect.gen(function* () {
        const questionRequested = activity({
          kind: "user-input.requested",
          requestId: "request-lifecycle-question",
          payload: {
            questions: [
              {
                question: "secret question body",
                options: [{ label: "secret option", description: "secret description" }],
              },
            ],
          },
          sequence: 1,
        });
        const questionResolved = activity({
          kind: "user-input.resolved",
          requestId: "request-lifecycle-question",
          sequence: 2,
          createdAt: "2026-07-21T00:00:11.000Z",
        });
        const approvalRequested = activity({
          kind: "approval.requested",
          requestId: "request-lifecycle-approval",
          payload: {
            requestKind: "command",
            command: "secret-command --token=secret",
          },
          sequence: 3,
          createdAt: "2026-07-21T00:00:12.000Z",
        });
        const approvalResolved = activity({
          kind: "approval.resolved",
          requestId: "request-lifecycle-approval",
          sequence: 4,
          createdAt: "2026-07-21T00:00:13.000Z",
        });
        let lifecycle = "question" as "question" | "approval" | "final";
        const transport: RemoteWatchTransport = {
          readThread: () =>
            Effect.sync(() => {
              switch (lifecycle) {
                case "question":
                  return snapshot({
                    sequence: 1,
                    status: "running",
                    activities: [questionRequested],
                  });
                case "approval":
                  return snapshot({
                    sequence: 3,
                    status: "running",
                    activities: [questionRequested, questionResolved, approvalRequested],
                  });
                case "final":
                  return snapshot({
                    sequence: 5,
                    status: "ready",
                    activities: [
                      questionRequested,
                      questionResolved,
                      approvalRequested,
                      approvalResolved,
                    ],
                    messageTexts: [{ text: "completed after both interactions" }],
                  });
              }
            }),
          subscribeThread: () => Effect.never,
        };

        const question = yield* watchRemoteThread({
          transport,
          threadId,
          timeoutMs: 10_000,
          interactionAware: true,
        }).pipe(Effect.flip);
        expect(question).toBeInstanceOf(RemoteWatchInteractionRequiredError);
        expect(question.message).not.toContain("secret");
        expect(JSON.parse(question.message).interaction).toMatchObject({
          kind: "user-input",
          requestId: "request-lifecycle-question",
        });

        lifecycle = "approval";
        const approval = yield* watchRemoteThread({
          transport,
          threadId,
          timeoutMs: 10_000,
          interactionAware: true,
        }).pipe(Effect.flip);
        expect(approval).toBeInstanceOf(RemoteWatchInteractionRequiredError);
        expect(approval.message).not.toContain("secret-command");
        expect(JSON.parse(approval.message).interaction).toEqual({
          kind: "approval",
          requestId: "request-lifecycle-approval",
          prompt: { requestKind: "command" },
        });

        lifecycle = "final";
        const final = yield* watchRemoteThread({
          transport,
          threadId,
          timeoutMs: 10_000,
          interactionAware: true,
        });
        expect(final.message.text).toBe("completed after both interactions");
      }),
  );

  it.effect("keeps legacy watch behavior unless interactions are explicitly enabled", () =>
    Effect.gen(function* () {
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({
                  sequence: 20,
                  status: "running",
                  activities: [
                    activity({
                      kind: "user-input.requested",
                      requestId: "request-legacy-watch",
                      payload: { questions: [{ options: [] }] },
                    }),
                  ],
                })
              : snapshot({
                  sequence: 21,
                  status: "ready",
                  messageTexts: [{ text: "legacy final" }],
                });
          }),
        subscribeThread: (input) => {
          expect(input.interactionAware).toBe(false);
          return Effect.succeed({ status: "ready", lastSequence: 21, observedRunning: true });
        },
      };

      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 });
      expect(result.message.text).toBe("legacy final");
    }),
  );

  it("never serializes prompt bodies, secrets, commands, argv, provider logs, or approval detail", () => {
    const secret = "TOP-SECRET-remote-watch-value";
    const prompt = selectPendingRemoteWatchInteraction(
      [
        activity({
          kind: "user-input.requested",
          requestId: "request-redaction-test",
          payload: {
            questions: [
              {
                id: secret,
                header: secret,
                question: secret,
                options: [{ label: secret, description: secret }],
              },
            ],
            command: secret,
            argv: [secret],
            providerLog: secret,
            detail: secret,
          },
        }),
      ],
      turnId,
    );
    const serializedPrompt = JSON.stringify(prompt);
    expect(serializedPrompt).not.toContain(secret);
    expect(serializedPrompt).not.toContain("command");
    expect(serializedPrompt).not.toContain("argv");
    expect(serializedPrompt).not.toContain("providerLog");
    expect(serializedPrompt).not.toContain("detail");

    const approval = selectPendingRemoteWatchInteraction(
      [
        activity({
          kind: "approval.requested",
          requestId: "approval-redaction-test",
          payload: {
            requestKind: "command",
            detail: secret,
            command: secret,
            argv: [secret],
            providerLog: secret,
          },
        }),
      ],
      turnId,
    );
    const serializedApproval = JSON.stringify(approval);
    expect(serializedApproval).not.toContain(secret);
    expect(serializedApproval).not.toContain("argv");
    expect(serializedApproval).not.toContain("providerLog");
    expect(serializedApproval).not.toContain("detail");
  });

  it.effect("subscribes after the exact initial HTTP snapshot sequence", () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 41, status: "running" })
              : snapshot({ sequence: 43, status: "ready", messageTexts: [{ text: "done" }] });
          }),
        subscribeThread: (input) =>
          Effect.sync(() => {
            cursors.push(input.afterSequence);
            return { status: "ready", lastSequence: 43, observedRunning: true };
          }),
      };

      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 });
      expect(cursors).toEqual([41]);
      expect(reads).toBe(2);
      expect(result.message.text).toBe("done");
    }),
  );

  it.effect("uses terminal session status even when the turn projection is stale", () =>
    Effect.gen(function* () {
      const terminal = snapshot({
        sequence: 44,
        status: "ready",
        messageTexts: [{ text: "authoritative" }],
      });
      const stale = {
        ...terminal,
        thread: {
          ...terminal.thread,
          latestTurn:
            terminal.thread.latestTurn === null
              ? null
              : { ...terminal.thread.latestTurn, state: "running" as const },
        },
      };
      let subscriptions = 0;
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(stale),
        subscribeThread: () => {
          subscriptions += 1;
          return Effect.never;
        },
      };

      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 });
      expect(subscriptions).toBe(0);
      expect(result.message.text).toBe("authoritative");
    }),
  );

  it.effect("returns an explicitly requested historical turn that has a final message", () =>
    Effect.gen(function* () {
      const historicalTurnId = TurnId.make("turn-historical");
      const historical = snapshot({
        sequence: 45,
        status: "running",
        messageTexts: [{ text: "historical final", turnId: historicalTurnId }],
      });
      let subscriptions = 0;
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(historical),
        subscribeThread: () => {
          subscriptions += 1;
          return Effect.never;
        },
      };

      const result = yield* watchRemoteThread({
        transport,
        threadId,
        requestedTurnId: historicalTurnId,
        timeoutMs: 10_000,
      });
      expect(subscriptions).toBe(0);
      expect(result.turnId).toBe(historicalTurnId);
      expect(result.message.text).toBe("historical final");
    }),
  );

  it.effect(
    "dedupes replayed sequences and stops only when the watched running session terminates",
    () =>
      Effect.gen(function* () {
        const result = yield* observeRemoteWatchStream({
          stream: Stream.fromIterable([
            { kind: "synchronized" as const },
            sessionEvent(10, "running"),
            sessionEvent(10, "ready"),
            sessionEvent(11, "ready"),
          ]),
          initialSequence: 9,
          targetTurnId: turnId,
          observedRunning: false,
        });

        expect(result).toEqual({ status: "ready", lastSequence: 11, observedRunning: true });
      }),
  );

  it.effect("does not treat a still-running session as terminal", () =>
    Effect.gen(function* () {
      const result = yield* observeRemoteWatchStream({
        stream: Stream.fromIterable([
          sessionEvent(10, "running"),
          sessionEvent(11, "running", TurnId.make("turn-next")),
          sessionEvent(12, "ready"),
        ]),
        initialSequence: 9,
        targetTurnId: turnId,
        observedRunning: false,
      });

      expect(result).toEqual({ status: "ready", lastSequence: 12, observedRunning: true });
    }),
  );

  it.effect("reconnects from the last cursor after a transport failure", () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      let reads = 0;
      let attempts = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 5, status: "running" })
              : snapshot({ sequence: 8, status: "ready", messageTexts: [{ text: "replayed" }] });
          }),
        subscribeThread: (input) => {
          cursors.push(input.afterSequence);
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new RemoteWatchFailure({
                  kind: "transport",
                  lastSequence: 7,
                  observedRunning: true,
                }),
              )
            : Effect.succeed({
                status: "ready" as const,
                lastSequence: 8,
                observedRunning: true,
              });
        },
      };

      const fiber = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("100 millis");
      const result = yield* Fiber.join(fiber);
      expect(cursors).toEqual([5, 7]);
      expect(result.message.text).toBe("replayed");
    }),
  );

  it("selects the final non-streaming assistant message for only the watched turn", () => {
    const otherTurn = TurnId.make("turn-other");
    const final = snapshot({
      sequence: 12,
      status: "ready",
      messageTexts: [
        { text: "wrong turn", turnId: otherTurn },
        { text: "partial", streaming: true },
        { text: "first final" },
        { text: "last final" },
      ],
    });

    expect(selectFinalAssistantMessage(final, turnId)?.text).toBe("last final");
  });

  it.effect("returns a distinct terminal-without-message outcome", () =>
    Effect.gen(function* () {
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 1, status: "running" })
              : snapshot({ sequence: 2, status: "interrupted" });
          }),
        subscribeThread: () =>
          Effect.succeed({ status: "interrupted", lastSequence: 2, observedRunning: true }),
      };

      const error = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 }).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(RemoteWatchTerminalWithoutMessageError);
      expect(error[Runtime.errorExitCode]).toBe(21);
    }),
  );

  it.effect("returns the dedicated timeout outcome", () =>
    Effect.gen(function* () {
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(snapshot({ sequence: 1, status: "running" })),
        subscribeThread: () => Effect.never,
      };
      const fiber = yield* watchRemoteThread({
        transport,
        threadId,
        timeoutMs: 1_000,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(RemoteWatchTimeoutError);
      expect(error[Runtime.errorExitCode]).toBe(23);
    }),
  );

  it("preserves the documented watch exit-code range from 20 through 26", () => {
    const errors = [
      new RemoteWatchTerminalWithoutMessageError({
        threadId,
        turnId,
        status: "stopped",
      }),
      new RemoteWatchTerminalWithoutMessageError({
        threadId,
        turnId,
        status: "interrupted",
      }),
      new RemoteWatchTerminalWithoutMessageError({
        threadId,
        turnId,
        status: "error",
      }),
      new RemoteWatchTimeoutError({ threadId, timeoutMs: 1_000 }),
      new RemoteWatchFailure({ kind: "transport" }),
      new RemoteWatchNoTurnError({ threadId }),
      new RemoteWatchInteractionRequiredError({
        threadId,
        turnId,
        interaction: {
          kind: "approval",
          requestId: "request-exit-code",
          prompt: { requestKind: "command" },
        },
      }),
    ];
    expect(errors.map((error) => error[Runtime.errorExitCode])).toEqual([
      20, 21, 22, 23, 24, 25, 26,
    ]);
  });

  it("formats text as only message text and JSON as a structured single result", () => {
    const result = {
      threadId,
      turnId,
      status: "ready" as const,
      message: {
        id: "assistant-final",
        text: "only this text",
        createdAt: "2026-07-21T00:01:00.000Z",
      },
    };
    expect(formatRemoteWatchResult(result, "text")).toBe("only this text");
    expect(JSON.parse(formatRemoteWatchResult(result, "json"))).toEqual(result);
  });
});
