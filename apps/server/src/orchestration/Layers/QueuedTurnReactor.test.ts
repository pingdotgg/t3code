import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ChildWaitCondition,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  QueuedTurnId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationCommand,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
  PullRequestMonitorError,
  PullRequestOperationError,
  type PullRequestMonitorSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PullRequestMonitorFeedbackService } from "../../pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor } from "../Services/QueuedTurnReactor.ts";
import { QueuedTurnReactorLive } from "./QueuedTurnReactor.ts";

const now = "2026-03-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-queued-startup");
const queuedTurnId = QueuedTurnId.make("queued-turn-startup");

function monitorSnapshot(
  headSha: string,
  sourceRevision = `rev-${headSha}`,
): PullRequestMonitorSnapshot {
  return {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    state: "open",
    isDraft: false,
    headSha,
    baseBranch: "main",
    headBranch: "feat/monitor",
    mergeability: "mergeable",
    behindBaseBy: 0,
    titleExcerpt: "Monitor me",
    url: "https://github.com/acme/app/pull/42",
    fetchedAt: now,
    sourceRevision,
    completeness: {
      reviewsComplete: true,
      reviewThreadsComplete: true,
      issueCommentsComplete: true,
      checksComplete: true,
      requiredChecksKnown: true,
      baseComparisonKnown: true,
    },
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    checkRuns: [],
  };
}

function queuedReadModel(
  queuedTurnOverrides: Partial<OrchestrationQueuedTurn> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Queued startup",
        modelSelection: {
          instanceId: ProviderInstanceId.make("copilot"),
          model: "gpt-5.4",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/handoff",
        worktreePath: "/tmp/handoff",
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        queuedTurns: [
          {
            id: queuedTurnId,
            threadId,
            message: {
              messageId: MessageId.make("message-startup"),
              role: "user",
              text: "continue after restart",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
            updatedAt: now,
            failedAt: null,
            failureMessage: null,
            ...queuedTurnOverrides,
          },
        ],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    workflowRuns: [],
    updatedAt: now,
  };
}

function delegatedReadModel(
  options: {
    readonly blockedItems?: boolean;
    readonly activeTurn?: boolean;
    readonly pendingApproval?: boolean;
  } = {},
): OrchestrationReadModel {
  const state = queuedReadModel();
  const parent = state.threads[0]!;
  const childId = ThreadId.make("child-settlement");
  const turnId = TurnId.make("turn-child-settlement");
  const completionActivity = {
    id: EventId.make("child-completion"),
    kind: "insights.turn.completed" as const,
    tone: "info" as const,
    summary: "Turn completed",
    payload: { state: "completed" },
    turnId,
    createdAt: now,
  };
  const child = {
    ...parent,
    id: childId,
    parentThreadId: parent.id,
    title: "Delegated child",
    latestTurn: {
      turnId,
      state: options.activeTurn ? ("running" as const) : ("completed" as const),
      requestedAt: now,
      startedAt: now,
      completedAt: options.activeTurn ? null : now,
      assistantMessageId: null,
    },
    queuedTurns: options.blockedItems
      ? [
          {
            ...parent.queuedTurns![0]!,
            id: QueuedTurnId.make("failed-child-queued-turn"),
            threadId: childId,
            failedAt: now,
            failureMessage: "The queued turn failed",
          },
        ]
      : [],
    activities: [
      ...(options.activeTurn ? [] : [completionActivity]),
      ...(options.pendingApproval
        ? [
            {
              id: EventId.make("child-pending-approval"),
              kind: "approval.requested" as const,
              tone: "approval" as const,
              summary: "Approval required",
              payload: { requestId: "approval-child-settlement" },
              turnId,
              createdAt: now,
            },
          ]
        : []),
    ],
    checkpoints: [],
    session: options.activeTurn
      ? {
          threadId: childId,
          status: "running" as const,
          providerName: "copilot",
          runtimeMode: "approval-required" as const,
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        }
      : null,
    nudging: {
      delegation: {
        assignmentId: MessageId.make("assignment-child-settlement"),
        dispatchId: "dispatch-child-settlement",
        dispatchSequence: 1,
        dispatchTurnId: turnId,
        followUp: "automatic" as const,
        completedAt: null,
        assignedAt: now,
      },
    },
  };
  return { ...state, threads: [parent, child] };
}

function childEvent(
  child: OrchestrationReadModel["threads"][number],
  eventId: string,
  type: "thread.queued-turn-deleted" | "thread.activity-appended",
  activityKind:
    | "approval.resolved"
    | "insights.turn.completed"
    | "tool.completed" = "approval.resolved",
): OrchestrationEvent {
  const eventBase = {
    sequence: 2,
    eventId: EventId.make(eventId),
    aggregateKind: "thread" as const,
    aggregateId: child.id,
    occurredAt: now,
    commandId: CommandId.make(eventId),
    causationEventId: null,
    correlationId: CommandId.make(eventId),
    metadata: {},
  };
  if (type === "thread.queued-turn-deleted") {
    return {
      ...eventBase,
      type,
      payload: {
        threadId: child.id,
        queuedTurnId: QueuedTurnId.make("failed-child-queued-turn"),
        deletedAt: now,
      },
    };
  }
  return {
    ...eventBase,
    type,
    payload: {
      threadId: child.id,
      activity: {
        id: EventId.make(`${eventId}-activity`),
        kind: activityKind,
        tone: "info",
        summary:
          activityKind === "approval.resolved"
            ? "Approval resolved"
            : activityKind === "insights.turn.completed"
              ? "Turn completed"
              : "Tool completed",
        payload:
          activityKind === "approval.resolved"
            ? { requestId: "approval-child-settlement" }
            : activityKind === "insights.turn.completed"
              ? { state: "completed" }
              : { toolCallId: "tool-call-1" },
        turnId: child.latestTurn?.turnId ?? null,
        createdAt: now,
      },
    },
  };
}

function settlementCommands(commands: ReadonlyArray<OrchestrationCommand>) {
  return commands.filter((command) => (command.type as string) === "thread.delegation.settle");
}

function unavailableAssignmentCommands(commands: ReadonlyArray<OrchestrationCommand>) {
  return commands.filter((command) => command.type === "thread.child.assignment.unavailable");
}

function pullRequestLayer(
  snapshot: PullRequestMonitorSnapshot,
  snapshotError?: PullRequestOperationError,
  snapshotDelayMs = 0,
) {
  return Layer.succeed(
    PullRequestService,
    PullRequestService.of({
      list: () => Effect.die("unused"),
      listStats: () => Effect.die("unused"),
      detail: () => Effect.die("unused"),
      activity: () => Effect.die("unused"),
      diff: () => Effect.die("unused"),
      runAction: () => Effect.die("unused"),
      comment: () => Effect.die("unused"),
      submitReview: () => Effect.die("unused"),
      replyToThread: () => Effect.die("unused"),
      setThreadResolution: () => Effect.die("unused"),
      reviewerCandidates: () => Effect.die("unused"),
      requestReviewers: () => Effect.die("unused"),
      invalidate: () => Effect.void,
      monitorSnapshot: () => {
        const result =
          snapshotError === undefined ? Effect.succeed(snapshot) : Effect.fail(snapshotError);
        return snapshotDelayMs > 0
          ? Effect.sleep(snapshotDelayMs).pipe(Effect.andThen(result))
          : result;
      },
    }),
  );
}

async function runReactor(
  readModelInput: OrchestrationReadModel,
  snapshot: PullRequestMonitorSnapshot,
  options?: {
    readonly waitAfterStartMs?: number;
    readonly firstDispatchDelayMs?: number;
    readonly snapshotDelayMs?: number;
    readonly snapshotError?: PullRequestOperationError;
    readonly onRetryQueuedDelivery?: (deliveryId: string) => void;
    readonly retryQueuedDeliveryError?: PullRequestMonitorError;
    readonly resume?: {
      readonly readModel: OrchestrationReadModel;
      readonly event: OrchestrationEvent;
      readonly additionalEvents?: ReadonlyArray<OrchestrationEvent>;
    };
    readonly providerInstances?: ServerSettings["providerInstances"];
    readonly optIn?: boolean;
    readonly enableAfterStart?: boolean;
  },
): Promise<ReadonlyArray<OrchestrationCommand>> {
  let readModel = readModelInput;
  const commands: OrchestrationCommand[] = [];
  const domainEvents = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
  let dispatchesStarted = 0;
  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        if ((command.type as string) === "thread.delegation.settle" && "threadId" in command) {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id !== command.threadId || !thread.nudging?.delegation
                ? thread
                : {
                    ...thread,
                    nudging: {
                      ...thread.nudging,
                      delegation: {
                        ...thread.nudging.delegation,
                        completedAt: now,
                        outcome: "result-available",
                      },
                    },
                  },
            ),
          };
        } else if (command.type === "thread.child.assignment.unavailable") {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id !== command.threadId || !thread.nudging?.wait
                ? thread
                : {
                    ...thread,
                    nudging: {
                      ...thread.nudging,
                      wait: {
                        ...thread.nudging.wait,
                        assignments: thread.nudging.wait.assignments.map((assignment) =>
                          assignment.childThreadId === command.childThreadId &&
                          assignment.assignmentId === command.assignmentId
                            ? { ...assignment, outcome: "blocked" as const }
                            : assignment,
                        ),
                      },
                    },
                  },
            ),
          };
        } else if (
          command.type === "thread.queued-turn.dispatch" ||
          command.type === "thread.queued-turn.delete"
        ) {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    queuedTurns: (thread.queuedTurns ?? []).filter(
                      (turn) => turn.id !== command.queuedTurnId,
                    ),
                  }
                : thread,
            ),
          };
        } else if (command.type === "thread.queued-turn.update") {
          readModel = {
            ...readModel,
            threads: readModel.threads.map((thread) =>
              thread.id === command.threadId
                ? {
                    ...thread,
                    queuedTurns: (thread.queuedTurns ?? []).map((queuedTurn) =>
                      queuedTurn.id === command.queuedTurnId
                        ? {
                            ...queuedTurn,
                            message: { ...queuedTurn.message, text: command.text },
                            ...(command.origin === undefined ? {} : { origin: command.origin }),
                            failedAt: null,
                            failureMessage: null,
                          }
                        : queuedTurn,
                    ),
                  }
                : thread,
            ),
          };
        }
        return { sequence: 2 };
      }),
    withWorktreeLock: (effect) =>
      Effect.suspend(() => {
        const delay = dispatchesStarted++ === 0 ? (options?.firstDispatchDelayMs ?? 0) : 0;
        return delay > 0 ? Effect.sleep(delay).pipe(Effect.andThen(effect)) : effect;
      }),
    streamDomainEvents: Stream.empty,
    acquireDomainEventSubscription: PubSub.subscribe(domainEvents),
  });
  const feedbackLayer = Layer.succeed(
    PullRequestMonitorFeedbackService,
    PullRequestMonitorFeedbackService.of({
      reconcileAndIngest: () => Effect.die("unused"),
      readinessSummary: () => Effect.die("unused"),
      ingestFindings: () => Effect.die("unused"),
      flushDueDeliveries: Effect.die("unused"),
      retryQueuedDelivery: ({ deliveryId }) =>
        options?.retryQueuedDeliveryError === undefined
          ? Effect.sync(() => options?.onRetryQueuedDelivery?.(deliveryId))
          : Effect.fail(options.retryQueuedDeliveryError),
      context: () => Effect.die("unused"),
      report: () => Effect.die("unused"),
      listOpenItems: () => Effect.die("unused"),
      listDeliveries: () => Effect.die("unused"),
      listReports: () => Effect.die("unused"),
    }),
  );
  const layer = QueuedTurnReactorLive.pipe(
    Layer.provide(engineLayer),
    Layer.provide(pullRequestLayer(snapshot, options?.snapshotError, options?.snapshotDelayMs)),
    Layer.provide(feedbackLayer),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        copilotAutomaticPrFeedback: {
          [ProviderInstanceId.make("copilot")]: options?.optIn ?? true,
        },
        providerInstances: options?.providerInstances ?? {
          [ProviderInstanceId.make("copilot")]: {
            driver: ProviderDriverKind.make("copilot"),
            enabled: true,
          },
        },
      }),
    ),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* QueuedTurnReactor;
        yield* reactor.start();
        if (options?.resume) {
          expect(commands).toHaveLength(0);
          readModel = options.resume.readModel;
          yield* Effect.forEach(
            [options.resume.event, ...(options.resume.additionalEvents ?? [])],
            (event) => PubSub.publish(domainEvents, event),
            { discard: true },
          );
        }
        if (options?.enableAfterStart) {
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({
            copilotAutomaticPrFeedback: { [ProviderInstanceId.make("copilot")]: true },
          });
        }
        yield* Effect.sleep(options?.waitAfterStartMs ?? 10);
      }),
    ).pipe(Effect.provide(layer)),
  );
  return commands;
}

describe("QueuedTurnReactor", () => {
  it("reconciles unavailable child assignments on startup", async () => {
    const base = delegatedReadModel();
    const parent = base.threads[0]!;
    const child = base.threads[1]!;
    const assignmentId = child.nudging!.delegation!.assignmentId;
    const detached = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.id === parent.id
          ? {
              ...thread,
              nudging: {
                wait: {
                  mode: "all" as const,
                  assignments: [{ childThreadId: child.id, assignmentId }],
                },
              },
            }
          : thread.id === child.id
            ? { ...thread, parentThreadId: null }
            : thread,
      ),
    };

    const commands = await runReactor(detached, monitorSnapshot("head"));

    expect(unavailableAssignmentCommands(commands)).toHaveLength(1);
    expect(unavailableAssignmentCommands(commands)[0]).toMatchObject({
      threadId: parent.id,
      childThreadId: child.id,
      assignmentId,
    });
  });

  it("invalidates a parent wait when its child is detached from the hierarchy", async () => {
    const base = delegatedReadModel({ activeTurn: true });
    const parent = base.threads[0]!;
    const child = base.threads[1]!;
    const assignmentId = child.nudging!.delegation!.assignmentId;
    const finished = delegatedReadModel();
    const detached = {
      ...finished,
      threads: finished.threads.map((thread) =>
        thread.id === parent.id
          ? {
              ...thread,
              queuedTurns: [],
              nudging: {
                wait: {
                  mode: "all" as const,
                  assignments: [{ childThreadId: child.id, assignmentId }],
                },
              },
            }
          : thread.id === child.id
            ? { ...thread, parentThreadId: null }
            : thread,
      ),
    };
    const event: OrchestrationEvent = {
      sequence: 2,
      eventId: EventId.make("child-detached"),
      aggregateKind: "thread",
      aggregateId: child.id,
      occurredAt: now,
      commandId: CommandId.make("child-detached"),
      causationEventId: null,
      correlationId: CommandId.make("child-detached"),
      metadata: {},
      type: "thread.decoupled",
      payload: { threadId: child.id, updatedAt: now },
    };
    const commands = await runReactor(base, monitorSnapshot("head"), {
      resume: {
        readModel: detached,
        event,
        additionalEvents: [{ ...event, eventId: EventId.make("child-detached-duplicate") }],
      },
    });

    expect(unavailableAssignmentCommands(commands)).toHaveLength(1);
    expect(unavailableAssignmentCommands(commands)[0]).toMatchObject({
      threadId: parent.id,
      childThreadId: child.id,
      assignmentId,
    });
  });

  it("settles after queued work and pending approval clear, despite duplicate state triggers", async () => {
    const blocked = delegatedReadModel({ blockedItems: true, pendingApproval: true });
    const child = blocked.threads[1]!;
    const cleared = {
      ...blocked,
      threads: blocked.threads.map((thread) =>
        thread.id === child.id
          ? {
              ...thread,
              queuedTurns: [],
              activities: [
                ...thread.activities,
                {
                  id: EventId.make("child-approval-resolved"),
                  kind: "approval.resolved" as const,
                  tone: "info" as const,
                  summary: "Approval resolved",
                  payload: { requestId: "approval-child-settlement" },
                  turnId: child.latestTurn!.turnId,
                  createdAt: now,
                },
              ],
            }
          : thread,
      ),
    };
    const commands = await runReactor(blocked, monitorSnapshot("head"), {
      resume: {
        readModel: cleared,
        event: childEvent(child, "queued-work-cleared", "thread.queued-turn-deleted"),
        additionalEvents: [
          childEvent(child, "approval-cleared", "thread.activity-appended"),
          childEvent(child, "duplicate-settlement-trigger", "thread.activity-appended"),
        ],
      },
    });

    expect(settlementCommands(commands)).toHaveLength(1);
  });

  it("settles provider completion when checkpoint capture is unavailable", async () => {
    const active = delegatedReadModel({ activeTurn: true });
    const idle = delegatedReadModel();
    const child = active.threads[1]!;
    const commands = await runReactor(active, monitorSnapshot("head"), {
      resume: {
        readModel: idle,
        event: childEvent(
          child,
          "provider-turn-completed",
          "thread.activity-appended",
          "insights.turn.completed",
        ),
      },
    });

    expect(settlementCommands(commands)).toHaveLength(1);
    expect(commands.some((command) => command.type === "thread.turn.diff.complete")).toBe(false);
  });

  it("does not settle from unrelated streamed activity", async () => {
    const active = delegatedReadModel({ activeTurn: true });
    const idle = delegatedReadModel();
    const child = active.threads[1]!;
    const commands = await runReactor(active, monitorSnapshot("head"), {
      resume: {
        readModel: idle,
        event: childEvent(child, "tool-completed", "thread.activity-appended", "tool.completed"),
      },
    });

    expect(settlementCommands(commands)).toHaveLength(0);
  });

  it("does not index settlement state for an unrelated session event", async () => {
    const initial = queuedReadModel();
    const ordinaryThread = { ...initial.threads[0]!, queuedTurns: [] };
    let threadIterations = 0;
    const threads = new Proxy([ordinaryThread], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          threadIterations += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const resumed = { ...initial, threads };
    const event: OrchestrationEvent = {
      sequence: 2,
      eventId: EventId.make("ordinary-session-set"),
      aggregateKind: "thread",
      aggregateId: ordinaryThread.id,
      occurredAt: now,
      commandId: CommandId.make("ordinary-session-set"),
      causationEventId: null,
      correlationId: CommandId.make("ordinary-session-set"),
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId: ordinaryThread.id,
        session: {
          threadId: ordinaryThread.id,
          status: "idle",
          providerName: "copilot",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      },
    };

    const commands = await runReactor(initial, monitorSnapshot("head"), {
      resume: { readModel: resumed, event },
    });

    expect(threadIterations).toBe(0);
    expect(settlementCommands(commands)).toHaveLength(0);
  });

  it("settles another thread while PR monitor revalidation is slow", async () => {
    const active = delegatedReadModel({ activeTurn: true });
    const parent = active.threads[0]!;
    const child = active.threads[1]!;
    const monitorOrigin: NonNullable<OrchestrationQueuedTurn["origin"]> = {
      kind: "pull-request-monitor",
      repository: "acme/app",
      number: 42,
      headSha: "head-current",
    };
    const initial = {
      ...active,
      threads: active.threads.map((thread) =>
        thread.id === parent.id ? { ...thread, queuedTurns: [] } : thread,
      ),
    };
    const idle = delegatedReadModel();
    const resumed = {
      ...idle,
      threads: idle.threads.map((thread) =>
        thread.id === parent.id
          ? {
              ...thread,
              queuedTurns: [
                {
                  ...thread.queuedTurns![0]!,
                  origin: monitorOrigin,
                },
              ],
            }
          : thread,
      ),
    };
    const monitorWake: OrchestrationEvent = {
      sequence: 2,
      eventId: EventId.make("monitor-wake"),
      aggregateKind: "thread",
      aggregateId: parent.id,
      occurredAt: now,
      commandId: CommandId.make("monitor-wake"),
      causationEventId: null,
      correlationId: CommandId.make("monitor-wake"),
      metadata: {},
      type: "thread.meta-updated",
      payload: { threadId: parent.id, updatedAt: now },
    };
    const commands = await runReactor(initial, monitorSnapshot("head-current"), {
      snapshotDelayMs: 200,
      waitAfterStartMs: 40,
      resume: {
        readModel: resumed,
        event: monitorWake,
        additionalEvents: [
          childEvent(
            child,
            "provider-turn-completed-behind-monitor",
            "thread.activity-appended",
            "insights.turn.completed",
          ),
        ],
      },
    });

    expect(settlementCommands(commands)).toHaveLength(1);
  });

  it("reconciles an idle open delegation on startup", async () => {
    const commands = await runReactor(delegatedReadModel(), monitorSnapshot("head"));

    expect(settlementCommands(commands)).toHaveLength(1);
  });

  it("retains a deadline wake that arrives while an explicit turn owns the drain", async () => {
    const collectUntil = new Date(Date.now() + 150).toISOString();
    const state = queuedReadModel({
      origin: {
        kind: "child-nudge",
        collectUntil,
        updates: [
          {
            id: "collected",
            childThreadId: ThreadId.make("child"),
            childTitle: "Child",
            assignmentId: MessageId.make("assignment"),
            kind: "result-available",
            summary: "Ready",
          },
        ],
      },
    });
    const queuedThread = state.threads[0]!;
    const commands = await runReactor(
      {
        ...state,
        threads: [
          {
            ...queuedThread,
            queuedTurns: [
              ...queuedThread.queuedTurns!,
              {
                ...queuedThread.queuedTurns![0]!,
                id: QueuedTurnId.make("explicit"),
                origin: undefined,
              },
            ],
          },
        ],
      },
      monitorSnapshot("head"),
      { firstDispatchDelayMs: 300, waitAfterStartMs: 600 },
    );
    expect(commands).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId: "explicit" },
      { type: "thread.queued-turn.dispatch", queuedTurnId },
    ]);
    const wake = commands[1]!;
    if (wake.type !== "thread.queued-turn.dispatch") throw new Error("Expected a nudge dispatch");
    expect(Date.parse(wake.dispatchedAt)).toBeGreaterThanOrEqual(Date.parse(collectUntil));
    expect(Date.parse(wake.dispatchedAt) - Date.parse(collectUntil)).toBeLessThan(1000);
  });

  it("leaves failed automatic nudges retryable without blocking explicit queued work", async () => {
    const state = queuedReadModel({
      failedAt: now,
      failureMessage: "Delivery failed",
      origin: {
        kind: "child-nudge",
        updates: [
          {
            id: "failed-delivery",
            childThreadId: ThreadId.make("child"),
            childTitle: "Child",
            assignmentId: MessageId.make("assignment"),
            kind: "result-available",
            summary: "Ready",
          },
        ],
      },
    });
    const queuedThread = state.threads[0]!;
    const commands = await runReactor(
      {
        ...state,
        threads: [
          {
            ...queuedThread,
            queuedTurns: [
              ...queuedThread.queuedTurns!,
              {
                ...queuedThread.queuedTurns![0]!,
                id: QueuedTurnId.make("explicit"),
                origin: undefined,
                failedAt: null,
                failureMessage: null,
              },
            ],
          },
        ],
      },
      monitorSnapshot("head"),
    );
    expect(commands).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId: "explicit" },
    ]);
  });

  it("reconstructs a persisted collection timer without waiting for another event or the recovery sweep", async () => {
    const collectUntil = new Date(Date.now() + 150).toISOString();
    const state = queuedReadModel({
      origin: {
        kind: "child-nudge",
        collectUntil,
        updates: [
          {
            id: "collected",
            childThreadId: ThreadId.make("child"),
            childTitle: "Child",
            assignmentId: MessageId.make("assignment"),
            kind: "result-available",
            summary: "Result ready",
          },
        ],
      },
    });
    const commands = await runReactor(state, monitorSnapshot("head"), { waitAfterStartMs: 300 });
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.type).toBe("thread.queued-turn.dispatch");
    if (command.type === "thread.queued-turn.dispatch") {
      expect(Date.parse(command.dispatchedAt)).toBeGreaterThanOrEqual(Date.parse(collectUntil));
    }
  });

  it("reconstructs an expired child-wait deadline at startup and expires it once", async () => {
    const deadlineAt = new Date(Date.now() - 50).toISOString();
    const state = queuedReadModel();
    const parent = state.threads[0]!;
    const wait = {
      mode: "all",
      deadlineAt,
      generationId: CommandId.make("deadline-wait-generation"),
      assignments: [
        {
          childThreadId: ThreadId.make("child"),
          assignmentId: MessageId.make("assignment"),
        },
      ],
    } as ChildWaitCondition;
    const persisted = {
      ...state,
      threads: [
        { ...parent, queuedTurns: [], nudging: { wait } },
        {
          ...parent,
          id: ThreadId.make("child"),
          parentThreadId: threadId,
          title: "Child",
          queuedTurns: [],
          nudging: {
            delegation: {
              assignmentId: MessageId.make("assignment"),
              followUp: "automatic" as const,
              completedAt: null,
            },
          },
        },
      ],
    };
    const commands = await runReactor(persisted, monitorSnapshot("head"), {
      waitAfterStartMs: 80,
    });

    expect(commands).toMatchObject([
      {
        type: "thread.child-wait.deadline-expire",
        threadId,
        expectedDeadlineAt: deadlineAt,
        expectedGenerationId: CommandId.make("deadline-wait-generation"),
      },
    ]);
  });

  it("does not issue a stalled wake when every child settles before the deadline", async () => {
    const deadlineAt = new Date(Date.now() + 120).toISOString();
    const state = queuedReadModel();
    const parent = state.threads[0]!;
    const waiting = {
      mode: "all",
      deadlineAt,
      assignments: [
        {
          childThreadId: ThreadId.make("child"),
          assignmentId: MessageId.make("assignment"),
        },
      ],
    } as ChildWaitCondition;
    const settled = {
      ...waiting,
      assignments: waiting.assignments.map((assignment) => ({
        ...assignment,
        outcome: "result-available" as const,
      })),
    };
    const waitingModel = {
      ...state,
      threads: [
        { ...parent, queuedTurns: [], nudging: { wait: waiting } },
        {
          ...parent,
          id: ThreadId.make("child"),
          parentThreadId: threadId,
          title: "Child",
          queuedTurns: [],
          nudging: {
            delegation: {
              assignmentId: MessageId.make("assignment"),
              followUp: "automatic" as const,
              completedAt: null,
            },
          },
        },
      ],
    };
    const settledModel = {
      ...state,
      threads: [
        { ...parent, queuedTurns: [], nudging: { wait: settled } },
        {
          ...parent,
          id: ThreadId.make("child"),
          parentThreadId: threadId,
          title: "Child",
          queuedTurns: [],
          nudging: {
            delegation: {
              assignmentId: MessageId.make("assignment"),
              followUp: "automatic" as const,
              completedAt: null,
            },
          },
        },
      ],
    };
    const commands = await runReactor(waitingModel, monitorSnapshot("head"), {
      waitAfterStartMs: 250,
      resume: {
        readModel: settledModel,
        event: {
          eventId: EventId.make("child-wait-settled"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("settle-child-wait"),
          causationEventId: null,
          correlationId: CommandId.make("settle-child-wait"),
          metadata: {},
          sequence: 2,
          type: "thread.meta-updated",
          payload: {
            threadId,
            nudging: { wait: settled },
            updatedAt: now,
          },
        },
      },
    });

    expect(commands.map((command) => command.type)).not.toContain(
      "thread.child-wait.deadline-expire",
    );
  });

  it("waits (without failing) while a child decision is pending", async () => {
    const decision = {
      id: "decision-1",
      childThreadId: ThreadId.make("child"),
      childTitle: "Child",
      assignmentId: MessageId.make("assignment"),
      kind: "decision-needed" as const,
      summary: "Which approach?",
    };
    const model = queuedReadModel();
    const waiting = {
      ...model,
      threads: model.threads.map((thread) => ({
        ...thread,
        nudging: {
          delegation: {
            assignmentId: MessageId.make("assignment"),
            followUp: "automatic" as const,
            completedAt: null,
            decision,
          },
        },
      })),
    };
    expect(await runReactor(waiting, monitorSnapshot("head-current"))).toEqual([]);
  });

  it("dispatches the correlated decision response ahead of waiting turns", async () => {
    const decision = {
      id: "decision-1",
      childThreadId: ThreadId.make("child"),
      childTitle: "Child",
      assignmentId: MessageId.make("assignment"),
      kind: "decision-needed" as const,
      summary: "Which approach?",
    };
    const answerId = QueuedTurnId.make("answer");
    const model = queuedReadModel();
    const thread = model.threads[0]!;
    // Production shape: the decider clears `decision` atomically when it
    // creates `pendingResponse`, so a real answer is decision-null plus
    // pendingResponse set.
    const commands = await runReactor(
      {
        ...model,
        threads: [
          {
            ...thread,
            queuedTurns: [
              ...(thread.queuedTurns ?? []),
              { ...thread.queuedTurns![0]!, id: answerId, origin: undefined },
            ],
            nudging: {
              delegation: {
                assignmentId: MessageId.make("assignment"),
                followUp: "automatic" as const,
                completedAt: null,
                decision: null,
                pendingResponse: { queuedTurnId: answerId, report: decision },
              },
            },
          },
        ],
      },
      monitorSnapshot("head-current"),
    );
    expect(commands).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId: answerId },
    ]);
  });

  it("recovers a nudge after restart, but skips it while paused without blocking user work", async () => {
    const ready = queuedReadModel({
      origin: {
        kind: "child-nudge",
        updates: [
          {
            id: "child-result",
            childThreadId: ThreadId.make("child"),
            childTitle: "Child",
            assignmentId: MessageId.make("assignment"),
            kind: "result-available",
            summary: "Inspect the result",
          },
        ],
      },
    });
    expect(await runReactor(ready, monitorSnapshot("head"))).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId },
    ]);
    const paused = {
      ...ready,
      threads: ready.threads.map((thread) => ({
        ...thread,
        nudging: { paused: true },
      })),
    };
    expect(await runReactor(paused, monitorSnapshot("head"))).toEqual([]);
    const explicit = {
      ...paused,
      threads: paused.threads.map((thread) => ({
        ...thread,
        queuedTurns: [
          ...thread.queuedTurns!,
          { ...thread.queuedTurns![0]!, id: QueuedTurnId.make("explicit"), origin: undefined },
        ],
      })),
    };
    expect(await runReactor(explicit, monitorSnapshot("head"))).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId: "explicit" },
    ]);
  });

  it("waits for the destination turn to finish before dispatching a persisted cross-thread message", async () => {
    const ready = queuedReadModel({
      origin: {
        kind: "cross-thread",
        sourceThreadId: ThreadId.make("source-no-longer-active"),
        sourceMessageId: MessageId.make("original-source-message"),
        sourceThreadTitle: "Source",
      },
    });
    const busy = {
      ...ready,
      threads: ready.threads.map((thread) => ({
        ...thread,
        session: {
          threadId,
          status: "running" as const,
          providerName: "copilot",
          runtimeMode: "approval-required" as const,
          activeTurnId: TurnId.make("destination-turn"),
          lastError: null,
          updatedAt: now,
        },
      })),
    };
    expect(await runReactor(busy, monitorSnapshot("head-current"))).toEqual([]);
    const commands = await runReactor(busy, monitorSnapshot("head-current"), {
      resume: {
        readModel: ready,
        event: {
          sequence: 2,
          eventId: EventId.make("destination-idle"),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.session-set",
          occurredAt: now,
          commandId: CommandId.make("destination-idle"),
          causationEventId: null,
          correlationId: CommandId.make("destination-idle"),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "copilot",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          },
        },
      },
    });
    expect(commands).toEqual([
      expect.objectContaining({ type: "thread.queued-turn.dispatch", threadId, queuedTurnId }),
    ]);
  });

  it("keeps disabled feedback pending without recording a failure", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
      }),
      monitorSnapshot("head-current"),
      {
        optIn: false,
      },
    );
    expect(commands).toEqual([]);
  });

  it("resumes pending feedback on opt-in without editing the message", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
      }),
      monitorSnapshot("head-current"),
      {
        optIn: false,
        enableAfterStart: true,
      },
    );
    expect(commands.map((command) => command.type)).toEqual(["thread.queued-turn.dispatch"]);
  });

  it("lets explicit work pass policy-blocked feedback", async () => {
    const model = queuedReadModel({
      origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
    });
    const thread = model.threads[0]!;
    const explicitId = QueuedTurnId.make("explicit");
    const commands = await runReactor(
      {
        ...model,
        threads: [
          {
            ...thread,
            queuedTurns: [
              ...(thread.queuedTurns ?? []),
              { ...thread.queuedTurns![0]!, id: explicitId, origin: undefined },
            ],
          },
        ],
      },
      monitorSnapshot("head-current"),
      { optIn: false },
    );
    expect(commands).toMatchObject([
      { type: "thread.queued-turn.dispatch", queuedTurnId: explicitId },
    ]);
  });

  it("does not block explicit user continuations with containment enabled", async () => {
    const commands = await runReactor(queuedReadModel(), monitorSnapshot("head-current"), {
      providerInstances: {
        [ProviderInstanceId.make("copilot")]: {
          driver: ProviderDriverKind.make("copilot"),
          enabled: true,
        },
      },
    });
    expect(commands.map((command) => command.type)).toEqual(["thread.queued-turn.dispatch"]);
  });

  it("does not repeatedly fail or dispatch already paused feedback", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
        failedAt: now,
        failureMessage: "Automatic PR feedback is paused",
      }),
      monitorSnapshot("head-current"),
    );
    expect(commands).toEqual([]);
  });

  it("allows a non-Copilot target without an existing Copilot session", async () => {
    const commands = await runReactor(
      queuedReadModel({
        modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "test-model" },
        origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
      }),
      monitorSnapshot("head-current"),
      {
        providerInstances: {
          [ProviderInstanceId.make("copilot")]: {
            driver: ProviderDriverKind.make("copilot"),
            enabled: true,
          },
          [ProviderInstanceId.make("other")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
          },
        },
      },
    );
    expect(commands.map((command) => command.type)).toEqual(["thread.queued-turn.dispatch"]);
  });

  it("recognizes custom instances of the Copilot ACP driver", async () => {
    const commands = await runReactor(
      queuedReadModel({
        modelSelection: { instanceId: ProviderInstanceId.make("custom"), model: "test-model" },
        origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
      }),
      monitorSnapshot("head-current"),
      {
        providerInstances: {
          [ProviderInstanceId.make("custom")]: {
            driver: ProviderDriverKind.make("copilot-acp-native"),
            enabled: true,
          },
        },
      },
    );
    expect(commands).toEqual([]);
  });

  it("protects existing Copilot work when automatic feedback switches providers", async () => {
    const model = queuedReadModel({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      origin: { kind: "pull-request-monitor", repository: "acme/app", number: 42 },
    });
    const thread = model.threads[0]!;
    const commands = await runReactor(
      {
        ...model,
        threads: [
          {
            ...thread,
            session: {
              threadId,
              status: "ready",
              providerName: "copilot",
              providerInstanceId: ProviderInstanceId.make("copilot"),
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
              runtimeMode: "approval-required",
            },
          },
        ],
      },
      monitorSnapshot("head-current"),
      { optIn: false },
    );
    expect(commands).toEqual([]);
  });

  it("dispatches a persisted continuation exactly once when the server restarts", async () => {
    const commands = await runReactor(queuedReadModel(), monitorSnapshot("head-current"));

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
    expect(commands[0]?.commandId).toEqual(expect.stringMatching(/^server:queued-turn\.dispatch:/));
  });

  it("dispatches after stopping a turn whose message shares its completion timestamp", async () => {
    const model = queuedReadModel();
    const thread = model.threads[0]!;
    const commands = await runReactor(
      {
        ...model,
        threads: [
          {
            ...thread,
            messages: [
              {
                id: MessageId.make("message-stopped"),
                role: "user",
                text: "stop",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
            latestTurn: {
              turnId: TurnId.make("turn-stopped"),
              state: "interrupted",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId: null,
            },
          },
        ],
      },
      monitorSnapshot("head-current"),
    );

    expect(commands.map((command) => command.type)).toEqual(["thread.queued-turn.dispatch"]);
  });

  it("deletes a stale PR monitor turn instead of dispatching it", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
        },
      }),
      monitorSnapshot("head-current", "revision-new"),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("suppresses a failed check from an older head while its rerun is pending", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-old",
          sourceRevision: "revision-old",
          events: [{ kind: "check-failed", sourceId: "check-old", detail: "Windows Smoke" }],
        },
      }),
      {
        ...monitorSnapshot("head-new", "revision-new"),
        checkRuns: [
          {
            id: "check-new",
            name: "Windows Smoke",
            status: "pending",
            headSha: "head-new",
            url: null,
            description: null,
          },
        ],
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("filters resolved findings and refreshes the prompt before dispatch", async () => {
    const findingContext = "Complete immutable review evidence.\n".repeat(100);
    const commands = await runReactor(
      queuedReadModel({
        message: {
          messageId: MessageId.make("message-startup"),
          role: "user",
          text: "stale behind-base and review prompt",
          attachments: [],
        },
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          deliveryId: "delivery-1",
          findingContext,
          availableTools: ["pr_monitor_context"],
          events: [
            { kind: "behind-base" },
            {
              kind: "new-review-comment",
              sourceId: "thread-live",
              detail: "please fix",
            },
          ],
        },
      }),
      {
        ...monitorSnapshot("head-current", "revision-new"),
        reviewThreads: [
          {
            id: "thread-live",
            author: { login: "reviewer", kind: "user" },
            path: "a.ts",
            line: 1,
            createdAt: now,
            updatedAt: now,
            resolved: false,
            latestCommentByViewer: false,
            bodyExcerpt: "please fix",
          },
        ],
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.update",
      threadId,
      queuedTurnId,
      origin: {
        kind: "pull-request-monitor",
        headSha: "head-current",
        sourceRevision: "revision-new",
        events: [{ kind: "new-review-comment", sourceId: "thread-live" }],
      },
    });
    expect(commands[0]?.type === "thread.queued-turn.update" ? commands[0].text : "").toContain(
      "Comment from reviewer",
    );
    expect(commands[0]?.type === "thread.queued-turn.update" ? commands[0].text : "").toContain(
      findingContext,
    );
    expect(commands[0]?.type === "thread.queued-turn.update" ? commands[0].text : "").not.toContain(
      "PR is behind",
    );
    expect(commands[1]).toMatchObject({
      type: "thread.queued-turn.dispatch",
      threadId,
      queuedTurnId,
    });
  });

  it("backs off a failed monitor revalidation without dispatching", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.update",
      origin: {
        kind: "pull-request-monitor",
        revalidationAttemptCount: 1,
      },
    });
  });

  it("returns a monitor delivery to durable retry before deleting its queued turn", async () => {
    const retriedDeliveries: string[] = [];
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
          deliveryId: "delivery-1",
          revalidationAttemptCount: 2,
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
        onRetryQueuedDelivery: (deliveryId) => retriedDeliveries.push(deliveryId),
      },
    );

    expect(retriedDeliveries).toEqual(["delivery-1"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-turn.delete",
      threadId,
      queuedTurnId,
    });
  });

  it("keeps the queued turn when durable retry cannot be recorded", async () => {
    const commands = await runReactor(
      queuedReadModel({
        origin: {
          kind: "pull-request-monitor",
          repository: "acme/app",
          number: 42,
          headSha: "head-current",
          sourceRevision: "revision-old",
          events: [{ kind: "behind-base" }],
          deliveryId: "delivery-1",
          revalidationAttemptCount: 2,
        },
      }),
      monitorSnapshot("head-current"),
      {
        snapshotError: new PullRequestOperationError({
          operation: "monitorSnapshot",
          detail: "provider unavailable",
        }),
        retryQueuedDeliveryError: new PullRequestMonitorError({
          message: "delivery store unavailable",
        }),
      },
    );

    expect(commands).toEqual([]);
  });
});
