import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildThreadContentTabs,
  resolveFallbackThreadTabAfterClose,
  type ThreadContentTab,
} from "./threadTabs";
import type { SidebarThreadSummary, Thread } from "./types";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeTab(id: string): ThreadContentTab {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    type: "chat",
    title: id,
    threadRef: scopeThreadRef(environmentId, threadId),
    active: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: undefined,
  };
}

function makeThread(
  id: string,
  options: {
    tabGroupId?: ThreadId;
    archivedAt?: string | null;
  } = {},
): Thread {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId,
    codexThreadId: null,
    projectId,
    tabGroupId: options.tabGroupId ?? threadId,
    tabType: "chat",
    title: id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    archivedAt: options.archivedAt ?? null,
    updatedAt: undefined,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

function makeSidebarThread(
  id: string,
  options: {
    tabGroupId: ThreadId;
    archivedAt?: string | null;
  },
): SidebarThreadSummary {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId,
    projectId,
    tabGroupId: options.tabGroupId,
    tabType: "chat",
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    archivedAt: options.archivedAt ?? null,
    updatedAt: undefined,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("buildThreadContentTabs", () => {
  it("omits archived tabs in the active tab group", () => {
    const tabGroupId = ThreadId.make("thread-group");
    const activeThread = makeThread("thread-active", { tabGroupId });
    const visibleThread = makeSidebarThread("thread-visible", { tabGroupId });
    const archivedThread = makeSidebarThread("thread-archived", {
      tabGroupId,
      archivedAt: "2026-06-01T00:00:01.000Z",
    });

    const tabs = buildThreadContentTabs({
      activeThread,
      activeThreadRef: scopeThreadRef(environmentId, activeThread.id),
      sidebarThreads: [visibleThread, archivedThread],
    });

    expect(tabs.map((tab) => tab.id)).toEqual([activeThread.id, visibleThread.id]);
  });

  it("returns no tabs when the active thread is archived", () => {
    const tabGroupId = ThreadId.make("thread-group");
    const activeThread = makeThread("thread-active", {
      tabGroupId,
      archivedAt: "2026-06-01T00:00:01.000Z",
    });
    const visibleThread = makeSidebarThread("thread-visible", { tabGroupId });

    expect(
      buildThreadContentTabs({
        activeThread,
        activeThreadRef: scopeThreadRef(environmentId, activeThread.id),
        sidebarThreads: [visibleThread],
      }),
    ).toEqual([]);
  });
});

describe("resolveFallbackThreadTabAfterClose", () => {
  it("selects the next tab when closing a tab before it", () => {
    const first = makeTab("thread-first");
    const second = makeTab("thread-second");
    const third = makeTab("thread-third");

    expect(resolveFallbackThreadTabAfterClose([first, second, third], first)).toBe(second);
  });

  it("selects the previous tab when closing the last tab", () => {
    const first = makeTab("thread-first");
    const second = makeTab("thread-second");

    expect(resolveFallbackThreadTabAfterClose([first, second], second)).toBe(first);
  });

  it("returns null when no sibling tab remains", () => {
    const only = makeTab("thread-only");

    expect(resolveFallbackThreadTabAfterClose([only], only)).toBeNull();
  });
});
