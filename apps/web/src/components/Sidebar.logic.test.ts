import { describe, expect, it, vi } from "vitest";

import {
  handleSidebarArrowNavigation,
  hasUnseenCompletion,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
} from "./Sidebar.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("keeps the accent palette for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-accent/85");
    expect(className).toContain("hover:bg-accent");
  });
});

describe("handleSidebarArrowNavigation", () => {
  let mockActiveElement: unknown = null;
  const originalDocument = globalThis.document;

  function setupMockDocument() {
    globalThis.document = {
      get activeElement() {
        return mockActiveElement;
      },
    } as Document;
  }

  function teardownMockDocument() {
    globalThis.document = originalDocument;
    mockActiveElement = null;
  }

  function makeMockElement(navItem: string, projectId: string, options?: { expanded?: boolean }) {
    const attrs: Record<string, string> = {};
    if (navItem === "project") {
      attrs["aria-expanded"] = options?.expanded ? "true" : "false";
    }
    const el = {
      dataset: { navItem, projectId },
      focus: vi.fn(),
      closest: () => el,
      getAttribute: (name: string) => attrs[name] ?? null,
    } as unknown as HTMLElement;
    return el;
  }

  function makeMockContainer(
    allItems: HTMLElement[],
    querySelectorResults: Record<string, HTMLElement | null>,
  ) {
    return {
      querySelectorAll: () => allItems,
      querySelector: (selector: string) => querySelectorResults[selector] ?? null,
    } as unknown as HTMLElement;
  }

  function makeKeyEvent(key: string) {
    const prevented = { value: false };
    return {
      event: {
        key,
        preventDefault: () => {
          prevented.value = true;
        },
      } as unknown as React.KeyboardEvent,
      prevented,
    };
  }

  it("moves focus down on ArrowDown", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: true });
    const thread = makeMockElement("thread", "p1");
    const container = makeMockContainer([project, thread], {
      '[data-nav-item="project"][data-project-id="p1"]': project,
    });
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowDown");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(thread.focus).toHaveBeenCalled();
    teardownMockDocument();
  });

  it("skips collapsed threads on ArrowDown", () => {
    setupMockDocument();
    const project1 = makeMockElement("project", "p1", { expanded: false });
    const thread1 = makeMockElement("thread", "p1");
    const project2 = makeMockElement("project", "p2");
    const container = makeMockContainer([project1, thread1, project2], {
      '[data-nav-item="project"][data-project-id="p1"]': project1,
    });
    mockActiveElement = project1;

    const { event } = makeKeyEvent("ArrowDown");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(project2.focus).toHaveBeenCalled();
    expect(thread1.focus).not.toHaveBeenCalled();
    teardownMockDocument();
  });

  it("moves focus up on ArrowUp", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: true });
    const thread = makeMockElement("thread", "p1");
    const container = makeMockContainer([project, thread], {
      '[data-nav-item="project"][data-project-id="p1"]': project,
    });
    mockActiveElement = thread;

    const { event } = makeKeyEvent("ArrowUp");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(project.focus).toHaveBeenCalled();
    teardownMockDocument();
  });

  it("does not move focus past the last item on ArrowDown", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1");
    const container = makeMockContainer([project], {});
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowDown");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(project.focus).not.toHaveBeenCalled();
    teardownMockDocument();
  });

  it("focuses parent project on ArrowLeft from a thread", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: true });
    const thread = makeMockElement("thread", "p1");
    const container = makeMockContainer([project, thread], {
      '[data-nav-item="project"][data-project-id="p1"]': project,
    });
    mockActiveElement = thread;

    const { event } = makeKeyEvent("ArrowLeft");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(project.focus).toHaveBeenCalled();
    teardownMockDocument();
  });

  it("collapses an expanded project on ArrowLeft", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: true });
    const thread = makeMockElement("thread", "p1");
    const container = makeMockContainer([project, thread], {
      '[data-nav-item="project"][data-project-id="p1"]': project,
    });
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowLeft");
    const toggleProject = vi.fn();
    handleSidebarArrowNavigation(event, container, toggleProject);

    expect(toggleProject).toHaveBeenCalledWith("p1");
    teardownMockDocument();
  });

  it("does not collapse a collapsed project on ArrowLeft", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: false });
    const container = makeMockContainer([project], {});
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowLeft");
    const toggleProject = vi.fn();
    handleSidebarArrowNavigation(event, container, toggleProject);

    expect(toggleProject).not.toHaveBeenCalled();
    teardownMockDocument();
  });

  it("expands a collapsed project on ArrowRight", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: false });
    const container = makeMockContainer([project], {});
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowRight");
    const toggleProject = vi.fn();
    handleSidebarArrowNavigation(event, container, toggleProject);

    expect(toggleProject).toHaveBeenCalledWith("p1");
    teardownMockDocument();
  });

  it("focuses first thread on ArrowRight from an expanded project", () => {
    setupMockDocument();
    const project = makeMockElement("project", "p1", { expanded: true });
    const thread = makeMockElement("thread", "p1");
    const container = makeMockContainer([project, thread], {
      '[data-nav-item="project"][data-project-id="p1"]': project,
      '[data-nav-item="thread"][data-project-id="p1"]': thread,
    });
    mockActiveElement = project;

    const { event } = makeKeyEvent("ArrowRight");
    handleSidebarArrowNavigation(event, container, vi.fn());

    expect(thread.focus).toHaveBeenCalled();
    teardownMockDocument();
  });

  it("ignores non-arrow keys", () => {
    const { event, prevented } = makeKeyEvent("Enter");
    handleSidebarArrowNavigation(event, {} as HTMLElement, vi.fn());

    expect(prevented.value).toBe(false);
  });

  it("ignores arrow keys when focus is on an input element", () => {
    setupMockDocument();
    mockActiveElement = { tagName: "INPUT" };

    const { event, prevented } = makeKeyEvent("ArrowDown");
    handleSidebarArrowNavigation(event, {} as HTMLElement, vi.fn());

    expect(prevented.value).toBe(false);
    teardownMockDocument();
  });

  it("ignores arrow keys when focus is on a textarea", () => {
    setupMockDocument();
    mockActiveElement = { tagName: "TEXTAREA" };

    const { event, prevented } = makeKeyEvent("ArrowDown");
    handleSidebarArrowNavigation(event, {} as HTMLElement, vi.fn());

    expect(prevented.value).toBe(false);
    teardownMockDocument();
  });
});
