import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Project, Thread } from "../types";
import {
  buildProjectActionGroups,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  prioritizeProjectGroupItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

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

const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Project",
    workspaceRoot: "/home/user/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildGroups(projects: Project[], environmentLabels = defaultEnvironmentLabels()) {
  return buildProjectActionGroups({
    projects,
    environmentLabels,
    valuePrefix: "new-thread-in",
    icon: () => null,
    runProject: async (_project) => undefined,
  });
}

function defaultEnvironmentLabels() {
  return [
    { environmentId: LOCAL_ENVIRONMENT_ID, label: "This device" },
    { environmentId: REMOTE_ENVIRONMENT_ID, label: "Work laptop" },
  ];
}

describe("buildProjectActionGroups", () => {
  it("groups projects by environment in catalog order with environment labels", () => {
    const groups = buildGroups([
      makeProject({
        id: ProjectId.make("project-remote"),
        environmentId: REMOTE_ENVIRONMENT_ID,
        title: "support-hub",
      }),
      makeProject({ id: ProjectId.make("project-local"), title: "t3code" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["This device", "Work laptop"]);
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      `new-thread-in:${LOCAL_ENVIRONMENT_ID}:project-local`,
    ]);
    expect(groups[1]?.items.map((item) => item.value)).toEqual([
      `new-thread-in:${REMOTE_ENVIRONMENT_ID}:project-remote`,
    ]);
  });

  it("labels the list as Projects when only one environment is known", () => {
    const groups = buildGroups(
      [makeProject()],
      [{ environmentId: LOCAL_ENVIRONMENT_ID, label: "This device" }],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Projects");
  });

  it("keeps the environment label when multiple environments are known but only one has projects", () => {
    const groups = buildGroups([makeProject()]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("This device");
  });

  it("makes group items searchable by their environment label", () => {
    const groups = buildGroups([
      makeProject({ id: ProjectId.make("project-local"), title: "t3code" }),
      makeProject({
        id: ProjectId.make("project-remote"),
        environmentId: REMOTE_ENVIRONMENT_ID,
        title: "support-hub",
      }),
    ]);

    const filtered = filterCommandPaletteGroups({
      activeGroups: groups,
      query: "work laptop",
      isInSubmenu: true,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.label).toBe("Work laptop");
    expect(filtered[0]?.items.map((item) => item.value)).toEqual([
      `new-thread-in:${REMOTE_ENVIRONMENT_ID}:project-remote`,
    ]);
  });

  it("keeps projects whose environment is missing from the catalog, labeled by id", () => {
    const unknownEnvironmentId = EnvironmentId.make("environment-unknown");
    const groups = buildGroups([
      makeProject(),
      makeProject({
        id: ProjectId.make("project-unknown"),
        environmentId: unknownEnvironmentId,
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["This device", unknownEnvironmentId]);
  });
});

describe("prioritizeProjectGroupItem", () => {
  it("moves the current project's group first and its item to the top of that group", () => {
    const groups = buildGroups([
      makeProject({ id: ProjectId.make("project-local"), title: "t3code" }),
      makeProject({
        id: ProjectId.make("project-remote-a"),
        environmentId: REMOTE_ENVIRONMENT_ID,
        title: "bolt",
      }),
      makeProject({
        id: ProjectId.make("project-remote-b"),
        environmentId: REMOTE_ENVIRONMENT_ID,
        title: "support-hub",
      }),
    ]);

    const prioritized = prioritizeProjectGroupItem(
      groups,
      `new-thread-in:${REMOTE_ENVIRONMENT_ID}:project-remote-b`,
    );

    expect(prioritized.map((group) => group.label)).toEqual(["Work laptop", "This device"]);
    expect(prioritized[0]?.items.map((item) => item.value)).toEqual([
      `new-thread-in:${REMOTE_ENVIRONMENT_ID}:project-remote-b`,
      `new-thread-in:${REMOTE_ENVIRONMENT_ID}:project-remote-a`,
    ]);
  });

  it("returns groups unchanged when there is no current project", () => {
    const groups = buildGroups([makeProject()]);

    expect(prioritizeProjectGroupItem(groups, null)).toEqual(groups);
    expect(prioritizeProjectGroupItem(groups, "new-thread-in:missing:missing")).toEqual(groups);
  });
});
