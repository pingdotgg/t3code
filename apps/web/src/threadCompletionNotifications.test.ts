import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { EnvironmentState } from "./store";
import { collectThreadCompletionNotifications } from "./threadCompletionNotifications";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

function makeEnvironmentState(overrides: {
  readonly bootstrapComplete: boolean;
  readonly turnId?: TurnId;
  readonly threadId?: ThreadId;
  readonly title?: string;
  readonly completedAt?: string;
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
        title: overrides.title ?? "Existing completed thread",
        interactionMode: "default",
        session: null,
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
