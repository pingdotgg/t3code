import {
  EnvironmentId,
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
  readonly activeTurnId?: TurnId | null;
}): EnvironmentState {
  const nextThreadId = overrides.threadId ?? threadId;
  const turnId = overrides.turnId ?? TurnId.make("turn-1");
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
          state: "completed",
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
      },
    },
    bootstrapComplete: overrides.bootstrapComplete,
  };
}

function makeTracker() {
  return {
    notifiedTurnKeys: new Set<string>(),
    bootstrappedEnvironmentIds: new Set<string>(),
  };
}

describe("collectThreadCompletionNotifications", () => {
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
