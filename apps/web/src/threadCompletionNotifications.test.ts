import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentState } from "./store";
import {
  collectStaleActiveTurnToastRequests,
  collectThreadCompletionNotifications,
  INTERRUPTED_NOTIFICATION_GRACE_MS,
} from "./threadCompletionNotifications";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const provider = ProviderDriverKind.make("copilot");
const providerInstanceId = ProviderInstanceId.make("copilot");

function makeEnvironmentState(overrides: {
  readonly bootstrapComplete: boolean;
  readonly turnId?: TurnId;
  readonly threadId?: ThreadId;
  readonly title?: string;
  readonly completedAt?: string;
  readonly turnState?: "completed" | "error" | "interrupted" | "running";
  readonly activeTurnId?: TurnId | null;
  readonly hasPendingQueuedTurn?: boolean;
  readonly terminalActivityState?: "completed" | "failed" | "interrupted" | "cancelled";
}): EnvironmentState {
  const nextThreadId = overrides.threadId ?? threadId;
  const turnId = overrides.turnId ?? TurnId.make("turn-1");
  const insightActivitiesByThreadId: EnvironmentState["insightActivitiesByThreadId"] =
    overrides.terminalActivityState === undefined
      ? {}
      : {
          [nextThreadId]: [
            {
              id: EventId.make("terminal-activity"),
              kind: "insights.turn.completed",
              tone: "info",
              summary: "Turn completed",
              payload: { state: overrides.terminalActivityState },
              turnId,
              createdAt: overrides.completedAt ?? "2026-06-10T00:01:00.000Z",
            },
          ],
        };
  return {
    projectIds: [projectId],
    projectById: {},
    threadIds: [nextThreadId],
    threadIdsByProjectId: {
      [projectId]: [nextThreadId],
    },
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    activityContextByThreadId: {},
    insightActivitiesByThreadId,
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    queuedTurnsByThreadId: {},
    sidebarThreadSummaryById: {
      [nextThreadId]: {
        id: nextThreadId,
        environmentId,
        projectId,
        parentThreadId: null,
        title: overrides.title ?? "Existing completed thread",
        interactionMode: "default",
        session:
          overrides.activeTurnId !== undefined
            ? {
                provider,
                providerInstanceId,
                status: "running",
                orchestrationStatus: "running",
                activeTurnId: overrides.activeTurnId ?? undefined,
                createdAt: "2026-06-10T00:00:00.000Z",
                updatedAt: "2026-06-10T00:01:00.000Z",
              }
            : null,
        createdAt: "2026-06-10T00:00:00.000Z",
        archivedAt: null,
        updatedAt: "2026-06-10T00:01:00.000Z",
        latestTurn: {
          turnId,
          state: overrides.turnState ?? "completed",
          requestedAt: "2026-06-10T00:00:00.000Z",
          startedAt: "2026-06-10T00:00:01.000Z",
          completedAt: overrides.completedAt ?? "2026-06-10T00:01:00.000Z",
          assistantMessageId: MessageId.make("assistant-message-1"),
        },
        branch: null,
        worktreePath: null,
        latestUserMessageAt: "2026-06-10T00:00:00.000Z",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        hasPendingQueuedTurn: overrides.hasPendingQueuedTurn ?? false,
      },
    },
    bootstrapComplete: overrides.bootstrapComplete,
  };
}

function makeTracker() {
  return {
    notifiedTurnKeys: new Set<string>(),
    bootstrappedEnvironmentIds: new Set<string>(),
    pendingInterruptedTurnKeys: new Map<string, number>(),
  };
}

function collectAfterBootstrap(
  environmentState: EnvironmentState,
  input: {
    readonly tracker?: ReturnType<typeof makeTracker>;
    readonly now?: number;
  } = {},
) {
  const tracker = input.tracker ?? makeTracker();
  collectThreadCompletionNotifications({
    environmentStateById: {
      [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
    },
    notificationMode: "all",
    activeThreadKey: null,
    isDocumentFocused: false,
    tracker,
  });

  return {
    tracker,
    requests: collectThreadCompletionNotifications({
      environmentStateById: { [environmentId]: environmentState },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  };
}

describe("collectThreadCompletionNotifications", () => {
  it("leaves child completions to the parent unless the parent is gone", () => {
    const childId = ThreadId.make("child-1");
    const parentId = ThreadId.make("parent-1");
    const withChild = (parentPresent: boolean): EnvironmentState => {
      const state = makeEnvironmentState({
        bootstrapComplete: true,
        threadId: childId,
        turnId: TurnId.make("child-turn"),
      });
      const child = { ...state.sidebarThreadSummaryById[childId]!, parentThreadId: parentId };
      return {
        ...state,
        sidebarThreadSummaryById: {
          [childId]: child,
          ...(parentPresent
            ? { [parentId]: { ...child, id: parentId, parentThreadId: null, latestTurn: null } }
            : {}),
        },
      };
    };

    expect(collectAfterBootstrap(withChild(true)).requests).toEqual([]);
    expect(collectAfterBootstrap(withChild(false)).requests).toHaveLength(1);
  });

  it("does not notify completed turns from the first bootstrapped snapshot after app restart", () => {
    const tracker = makeTracker();

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {},
        notificationMode: "background-only",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
        },
        notificationMode: "background-only",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);
  });

  it("notifies new completed turns after the environment bootstrap boundary", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "background-only",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const requests = collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          threadId: ThreadId.make("thread-2"),
          turnId: TurnId.make("turn-2"),
          title: "Newly completed thread",
          completedAt: "2026-06-10T00:02:00.000Z",
        }),
      },
      notificationMode: "background-only",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(requests).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-2",
        turnId: "turn-2",
        title: "Chat completed",
        body: "Newly completed thread",
        status: "completed",
      },
    ]);
  });

  it("seeds while notifications are off so enabling them does not notify historical turns", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "off",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);
  });

  it("does not notify a completed turn while a handoff/user continuation is still queued", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const completedWithQueue = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-handoff"),
      turnId: TurnId.make("turn-handoff-boundary"),
      title: "Handoff in progress",
      completedAt: "2026-06-10T00:03:00.000Z",
      hasPendingQueuedTurn: true,
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: completedWithQueue,
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toEqual([]);

    // Once the queue drains, the same completed boundary may notify if it is
    // still the latest terminal turn and has not been seeded yet.
    const afterQueueDrained = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-handoff"),
      turnId: TurnId.make("turn-handoff-boundary"),
      title: "Handoff in progress",
      completedAt: "2026-06-10T00:03:00.000Z",
    });

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: {
          [environmentId]: afterQueueDrained,
        },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
      }),
    ).toMatchObject([
      {
        kind: "thread-turn-completed",
        threadId: "thread-handoff",
        turnId: "turn-handoff-boundary",
        title: "Chat completed",
      },
    ]);
  });

  it("prefers a later successful completion over a transient interrupted projection", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const transientInterrupted = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-racy-completion"),
      turnId: TurnId.make("turn-racy-completion"),
      turnState: "interrupted",
    });
    expect(
      collectThreadCompletionNotifications({
        environmentStateById: { [environmentId]: transientInterrupted },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
        now: 1_000,
      }),
    ).toEqual([]);

    const authoritativeCompletion = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-racy-completion"),
      turnId: TurnId.make("turn-racy-completion"),
      turnState: "completed",
    });
    expect(
      collectThreadCompletionNotifications({
        environmentStateById: { [environmentId]: authoritativeCompletion },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
        now: 1_001,
      }),
    ).toMatchObject([
      {
        threadId: "thread-racy-completion",
        turnId: "turn-racy-completion",
        title: "Chat completed",
        status: "completed",
      },
    ]);
  });

  it.each([
    {
      name: "successful provider completion over a checkpoint interruption",
      turnState: "interrupted" as const,
      terminalActivityState: "completed" as const,
      expectedStatus: "completed",
      expectedTitle: "Chat completed",
    },
    {
      name: "provider interruption over a stale completed shell state",
      turnState: "completed" as const,
      terminalActivityState: "interrupted" as const,
      expectedStatus: "interrupted",
      expectedTitle: "Chat interrupted",
    },
  ])("prefers $name", ({ turnState, terminalActivityState, expectedStatus, expectedTitle }) => {
    const { requests, tracker } = collectAfterBootstrap(
      makeEnvironmentState({
        bootstrapComplete: true,
        threadId: ThreadId.make("thread-provider-terminal"),
        turnId: TurnId.make("turn-provider-terminal"),
        turnState,
        terminalActivityState,
      }),
      { now: 1_000 },
    );

    expect(requests).toMatchObject([
      {
        threadId: "thread-provider-terminal",
        turnId: "turn-provider-terminal",
        title: expectedTitle,
        status: expectedStatus,
      },
    ]);
    expect(tracker.pendingInterruptedTurnKeys).toEqual(new Map());
  });

  it("notifies an interruption that remains authoritative past the grace period", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const interrupted = makeEnvironmentState({
      bootstrapComplete: true,
      threadId: ThreadId.make("thread-interrupted"),
      turnId: TurnId.make("turn-interrupted"),
      turnState: "interrupted",
    });
    expect(
      collectThreadCompletionNotifications({
        environmentStateById: { [environmentId]: interrupted },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
        now: 1_000,
      }),
    ).toEqual([]);

    expect(
      collectThreadCompletionNotifications({
        environmentStateById: { [environmentId]: interrupted },
        notificationMode: "all",
        activeThreadKey: null,
        isDocumentFocused: false,
        tracker,
        now: 1_000 + INTERRUPTED_NOTIFICATION_GRACE_MS,
      }),
    ).toMatchObject([
      {
        threadId: "thread-interrupted",
        turnId: "turn-interrupted",
        title: "Chat interrupted",
        status: "interrupted",
      },
    ]);
  });

  it("cancels a pending interruption while a continuation is queued", () => {
    const tracker = makeTracker();
    collectThreadCompletionNotifications({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({ bootstrapComplete: true }),
      },
      notificationMode: "all",
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    });

    const interrupted = {
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          threadId: ThreadId.make("thread-queued-interruption"),
          turnId: TurnId.make("turn-queued-interruption"),
          turnState: "interrupted",
        }),
      },
      notificationMode: "all" as const,
      activeThreadKey: null,
      isDocumentFocused: false,
      tracker,
    };
    collectThreadCompletionNotifications({ ...interrupted, now: 1_000 });

    expect(
      collectThreadCompletionNotifications({
        ...interrupted,
        environmentStateById: {
          [environmentId]: makeEnvironmentState({
            bootstrapComplete: true,
            threadId: ThreadId.make("thread-queued-interruption"),
            turnId: TurnId.make("turn-queued-interruption"),
            turnState: "interrupted",
            hasPendingQueuedTurn: true,
          }),
        },
        now: 1_000 + INTERRUPTED_NOTIFICATION_GRACE_MS,
      }),
    ).toEqual([]);
    expect(tracker.pendingInterruptedTurnKeys).toEqual(new Map());

    expect(
      collectThreadCompletionNotifications({
        ...interrupted,
        now: 1_000 + INTERRUPTED_NOTIFICATION_GRACE_MS + 1,
      }),
    ).toEqual([]);
    expect(tracker.pendingInterruptedTurnKeys.size).toBe(1);
  });
});

describe("collectStaleActiveTurnToastRequests", () => {
  it("warns when a completed latest turn is still marked active", () => {
    const notifiedTurnKeys = new Set<string>();
    const turnId = TurnId.make("turn-stale-active");

    const requests = collectStaleActiveTurnToastRequests({
      environmentStateById: {
        [environmentId]: makeEnvironmentState({
          bootstrapComplete: true,
          activeTurnId: turnId,
          turnId,
          title: "Completed but still active",
        }),
      },
      notifiedTurnKeys,
    });

    expect(requests).toEqual([
      {
        environmentId,
        threadId,
        turnId,
        title: "Chat still looked active after completion",
        threadTitle: "Completed but still active",
      },
    ]);
  });

  it("does not warn twice for the same stale active turn", () => {
    const notifiedTurnKeys = new Set<string>();
    const turnId = TurnId.make("turn-stale-active");
    const environmentStateById = {
      [environmentId]: makeEnvironmentState({
        bootstrapComplete: true,
        activeTurnId: turnId,
        turnId,
      }),
    };

    collectStaleActiveTurnToastRequests({ environmentStateById, notifiedTurnKeys });

    expect(collectStaleActiveTurnToastRequests({ environmentStateById, notifiedTurnKeys })).toEqual(
      [],
    );
  });

  it("does not warn during bootstrap or for a different active turn", () => {
    const turnId = TurnId.make("turn-completed");

    expect(
      collectStaleActiveTurnToastRequests({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({
            bootstrapComplete: false,
            activeTurnId: turnId,
            turnId,
          }),
        },
        notifiedTurnKeys: new Set<string>(),
      }),
    ).toEqual([]);

    expect(
      collectStaleActiveTurnToastRequests({
        environmentStateById: {
          [environmentId]: makeEnvironmentState({
            bootstrapComplete: true,
            activeTurnId: TurnId.make("turn-in-flight"),
            turnId,
          }),
        },
        notifiedTurnKeys: new Set<string>(),
      }),
    ).toEqual([]);
  });
});
