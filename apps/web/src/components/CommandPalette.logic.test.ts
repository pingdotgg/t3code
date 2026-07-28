import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  buildNewThreadPickerGroups,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  resolveCommandPaletteEmptyStateMessage,
  shouldClearAddProjectEnvironmentOnPop,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const makeActionItem = (value: string) => ({
  kind: "action" as const,
  value,
  searchTerms: [],
  title: value,
  icon: null,
  run: async () => undefined,
});

describe("buildNewThreadPickerGroups", () => {
  const addProjectItem = makeActionItem("action:add-project");

  it("waits for projects before showing an empty picker", () => {
    expect(
      buildNewThreadPickerGroups({
        projectItems: [],
        addProjectItem,
        areProjectsLoading: true,
      }),
    ).toEqual([]);
  });

  it("keeps Add project keyboard-addressable after project choices", () => {
    const projectItem = makeActionItem("new-thread-in:environment-local:project-1");

    expect(
      buildNewThreadPickerGroups({
        projectItems: [projectItem],
        addProjectItem,
        areProjectsLoading: false,
      }).map((group) => ({
        value: group.value,
        items: group.items.map((item) => item.value),
      })),
    ).toEqual([
      {
        value: "new-thread-projects",
        items: ["new-thread-in:environment-local:project-1"],
      },
      { value: "new-thread-actions", items: ["action:add-project"] },
    ]);
  });

  it("offers Add project when loading completes without projects", () => {
    expect(
      buildNewThreadPickerGroups({
        projectItems: [],
        addProjectItem,
        areProjectsLoading: false,
      }),
    ).toEqual([
      {
        value: "new-thread-actions",
        label: "Actions",
        items: [addProjectItem],
      },
    ]);
  });
});

describe("resolveCommandPaletteEmptyStateMessage", () => {
  it("keeps browse/create guidance when the new-thread picker has no projects", () => {
    expect(
      resolveCommandPaletteEmptyStateMessage({
        contextualMessage: "Press Enter to create this folder and add it as a project.",
        isNewThreadProjectPickerView: true,
        projectCount: 0,
        allEnvironmentShellsBootstrapped: true,
        query: "/work/new-project",
      }),
    ).toBe("Press Enter to create this folder and add it as a project.");
  });

  it("uses zero-project guidance only when no more specific state applies", () => {
    expect(
      resolveCommandPaletteEmptyStateMessage({
        isNewThreadProjectPickerView: true,
        projectCount: 0,
        allEnvironmentShellsBootstrapped: true,
        query: "",
      }),
    ).toBe("No projects yet. Add a project to start a thread.");
    expect(
      resolveCommandPaletteEmptyStateMessage({
        isNewThreadProjectPickerView: true,
        projectCount: 0,
        allEnvironmentShellsBootstrapped: false,
        query: "",
      }),
    ).toBe("Loading projects…");
  });
});

describe("shouldClearAddProjectEnvironmentOnPop", () => {
  it("clears the selected environment when returning from source selection", () => {
    expect(
      shouldClearAddProjectEnvironmentOnPop({
        viewStackDepth: 2,
        currentGroupValue: "sources:environment-local",
        addProjectEnvironmentId: "environment-local",
      }),
    ).toBe(true);
  });

  it("keeps the selected environment while returning to source selection", () => {
    expect(
      shouldClearAddProjectEnvironmentOnPop({
        viewStackDepth: 3,
        currentGroupValue: undefined,
        addProjectEnvironmentId: "environment-local",
      }),
    ).toBe(false);
  });
});

describe("filterCommandPaletteGroups", () => {
  it("keeps dedicated picker actions visible for the actions-only filter", () => {
    const addProjectItem = {
      ...makeActionItem("action:add-project"),
      searchTerms: ["add project"],
    };

    expect(
      filterCommandPaletteGroups({
        activeGroups: [
          {
            value: "new-thread-actions",
            label: "Actions",
            items: [addProjectItem],
          },
        ],
        query: ">",
        isInSubmenu: true,
        projectSearchItems: [],
        threadSearchItems: [],
      }),
    ).toEqual([
      {
        value: "new-thread-actions",
        label: "Actions",
        items: [addProjectItem],
      },
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});
