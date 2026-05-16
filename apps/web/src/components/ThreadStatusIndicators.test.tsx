import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useUiStateStore } from "../uiStateStore";
import type { SidebarThreadSummary } from "../types";
import { resolveThreadRowStatus } from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

function makeLatestTurn(): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  };
}

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    interactionMode: "default",
    session: {
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:06:00.000Z",
      orchestrationStatus: "ready",
    },
    createdAt: "2026-03-09T09:59:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:06:00.000Z",
    latestTurn: makeLatestTurn(),
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("ThreadRowLeadingStatus", () => {
  beforeEach(() => {
    useUiStateStore.setState({
      threadLastVisitedAtById: {},
      threadChangedFilesExpandedById: {},
      threadDismissedStatusKeyById: {},
    });
  });

  it("hides dismissed thread notifications in compact rows", () => {
    const thread = makeThread({ hasPendingApprovals: true });
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));

    useUiStateStore.setState({
      threadDismissedStatusKeyById: {
        [threadKey]:
          "Pending Approval:2026-03-09T10:06:00.000Z:turn-1:2026-03-09T10:05:00.000Z:2026-03-09T10:06:00.000Z",
      },
    });

    const status = resolveThreadRowStatus({
      thread,
      dismissedStatusKey: useUiStateStore.getState().threadDismissedStatusKeyById[threadKey],
    });

    expect(status).toBeNull();
  });

  it("shows thread notifications when they have not been dismissed", () => {
    const status = resolveThreadRowStatus({
      thread: makeThread({ hasPendingApprovals: true }),
    });

    expect(status?.label).toBe("Pending Approval");
  });
});
