import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  SHELL_SIDEBAR_SETTLED_LIMIT,
  buildLogicalProjectKeyMap,
  buildShellSidebarState,
} from "./shellSidebarState";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeProjectGroup(): SidebarProjectSnapshot {
  return {
    id: projectId,
    environmentId,
    title: "T3 Code",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    projectKey: "logical:t3code",
    displayName: "T3 Code",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [],
    memberProjectRefs: [{ environmentId, projectId }],
    remoteEnvironmentLabels: [],
  };
}

describe("buildLogicalProjectKeyMap", () => {
  it("maps every member ref of a group to the group's logical key", () => {
    const map = buildLogicalProjectKeyMap([makeProjectGroup()]);
    expect(map.get(`${environmentId}:${projectId}`)).toBe("logical:t3code");
  });
});

describe("buildShellSidebarState", () => {
  const partition = {
    pinnedThreads: [
      makeThread({ id: ThreadId.make("pinned"), pinnedAt: "2026-03-09T11:00:00.000Z" }),
    ],
    reorderablePinnedKeys: new Set<string>(),
    activeThreads: [
      makeThread({
        id: ThreadId.make("working"),
        title: "Working thread",
        branch: "feat/x",
        session: { status: "running" } as never,
        latestTurn: { completedAt: "2026-03-09T12:00:00.000Z" } as never,
      }),
    ],
    snoozedThreads: [
      makeThread({
        id: ThreadId.make("napping"),
        snoozedAt: "2026-03-09T11:30:00.000Z",
        snoozedUntil: "2026-03-09T13:30:00.000Z",
      }),
    ],
    settledThreads: Array.from({ length: SHELL_SIDEBAR_SETTLED_LIMIT + 5 }, (_, index) =>
      makeThread({ id: ThreadId.make(`settled-${index}`) }),
    ),
    snoozeNow: "2026-03-09T12:00:00.000Z",
  };

  it("projects threads onto shell rows with keys, status, and unread", () => {
    const state = buildShellSidebarState({
      projectGroups: [makeProjectGroup()],
      scopeProjectKey: null,
      partition,
      capabilitiesFor: () => ({ threadSettlement: true, threadSnooze: true }),
      threadCountByLogicalKey: new Map([["logical:t3code", 3]]),
      lastVisitedAtByKey: { [`${environmentId}:working`]: "2026-03-09T11:00:00.000Z" },
      drafts: [],
      activeThreadKey: `${environmentId}:pinned`,
      activeDraftId: null,
    });

    expect(state.projects).toEqual([
      {
        key: "logical:t3code",
        displayName: "T3 Code",
        environmentId,
        projectId,
        workspaceRoot: "/repo",
        threadCount: 3,
      },
    ]);
    expect(state.pinned[0]).toMatchObject({
      key: `${environmentId}:pinned`,
      projectKey: "logical:t3code",
      pinned: true,
      status: "ready",
      canSettle: true,
      canSnooze: true,
      wakeLabel: null,
      wokeAt: null,
    });
    expect(state.snoozed[0]).toMatchObject({ key: `${environmentId}:napping`, wakeLabel: "2h" });
    expect(state.active[0]).toMatchObject({
      key: `${environmentId}:working`,
      title: "Working thread",
      branch: "feat/x",
      status: "working",
      statusLabel: "Working",
      unread: true,
    });
    expect(state.activeThreadKey).toBe(`${environmentId}:pinned`);
  });

  it("caps settled rows and reports the full count", () => {
    const state = buildShellSidebarState({
      projectGroups: [makeProjectGroup()],
      scopeProjectKey: "logical:t3code",
      partition,
      capabilitiesFor: () => undefined,
      threadCountByLogicalKey: new Map(),
      lastVisitedAtByKey: {},
      drafts: [{ draftId: "draft-1", projectKey: "logical:t3code", label: "Draft" }],
      activeThreadKey: null,
      activeDraftId: "draft-1",
    });
    expect(state.pinned[0]).toMatchObject({ canSettle: false, canSnooze: false });
    expect(state.settled).toHaveLength(SHELL_SIDEBAR_SETTLED_LIMIT);
    expect(state.settledTotal).toBe(SHELL_SIDEBAR_SETTLED_LIMIT + 5);
    expect(state.scopeProjectKey).toBe("logical:t3code");
    expect(state.drafts).toHaveLength(1);
    expect(state.activeDraftId).toBe("draft-1");
  });

  it("keeps the woke signal until the user visits after the wake", () => {
    const woke = makeThread({
      id: ThreadId.make("woke"),
      snoozedAt: "2026-03-09T09:00:00.000Z",
      snoozedUntil: "2026-03-09T11:00:00.000Z",
    });
    const build = (lastVisitedAt: string | undefined) =>
      buildShellSidebarState({
        projectGroups: [makeProjectGroup()],
        scopeProjectKey: null,
        partition: { ...partition, activeThreads: [woke] },
        capabilitiesFor: () => ({ threadSnooze: true }),
        threadCountByLogicalKey: new Map(),
        lastVisitedAtByKey: { [`${environmentId}:woke`]: lastVisitedAt },
        drafts: [],
        activeThreadKey: null,
        activeDraftId: null,
      });
    expect(build(undefined).active[0]?.wokeAt).toBe("2026-03-09T11:00:00.000Z");
    expect(build("2026-03-09T10:00:00.000Z").active[0]?.wokeAt).toBe("2026-03-09T11:00:00.000Z");
    expect(build("2026-03-09T11:30:00.000Z").active[0]?.wokeAt).toBeNull();
    expect(build(undefined).active[0]).toMatchObject({ canSettle: false, canSnooze: true });
  });
});
