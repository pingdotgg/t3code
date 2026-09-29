import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { Project, Thread } from "../types";
import {
  buildCommandPaletteSearchIndex,
  buildProjectActionItems,
  buildThreadActionItems,
  buildTranscriptActionItems,
  filterCommandPaletteGroups,
  getPaletteMatchSource,
  splitPaletteHighlightParts,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    name: "Project",
    cwd: "/Users/example/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    parentThreadId: null,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    pendingRuntimeMode: null,
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("buildCommandPaletteSearchIndex", () => {
  it("normalizes terms once for filtering and ranking", () => {
    expect(buildCommandPaletteSearchIndex(["  Fix   Navbar  ", "", "Feature/Branch"])).toEqual({
      normalizedTerms: ["fix navbar", "feature/branch"],
      haystack: "fix navbar feature/branch",
    });
  });
});

describe("transcript search identity", () => {
  it("deduplicates mixed metadata/transcript matches only within the same environment", async () => {
    const remote = EnvironmentId.make("environment-remote");
    const sharedThreadId = ThreadId.make("shared-thread");
    const matches = [LOCAL_ENVIRONMENT_ID, remote].map((environmentId) => ({
      environmentId,
      match: {
        threadId: sharedThreadId,
        messageId: MessageId.make("message-1"),
        title: "Matching thread",
        projectTitle: "Project",
        branch: null,
        role: "user" as const,
        excerpt: "Search phrase",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    }));
    const metadataItems = buildThreadActionItems({
      threads: [makeThread({ id: sharedThreadId })],
      projectTitleById: new Map(),
      sortOrder: "created_at",
      icon: null,
      runThread: async () => {},
    });
    const runThread = vi.fn(async () => {});
    const items = buildTranscriptActionItems({
      matches,
      metadataGroups: [{ value: "threads", label: "Threads", items: metadataItems }],
      icon: null,
      runThread,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      environmentId: remote,
      value: `transcript:${remote}:${sharedThreadId}`,
    });
    await items[0]!.run();
    expect(runThread).toHaveBeenCalledWith({
      environmentId: remote,
      threadId: sharedThreadId,
      messageId: MessageId.make("message-1"),
    });
    expect(
      buildTranscriptActionItems({ matches, metadataGroups: [], icon: null, runThread }).map(
        (item) => item.environmentId,
      ),
    ).toEqual([LOCAL_ENVIRONMENT_ID, remote]);
  });
});

describe("buildProjectActionItems", () => {
  it("precomputes search indexes for project results", () => {
    const items = buildProjectActionItems({
      projects: [
        makeProject({
          name: "Web App",
          cwd: "/Users/example/large project",
        }),
      ],
      valuePrefix: "project",
      icon: () => null,
      runProject: async (_project) => undefined,
    });

    expect(items[0]?.searchIndex).toEqual({
      normalizedTerms: ["web app", "/users/example/large project", "environment-local"],
      haystack: "web app /users/example/large project environment-local",
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "large project",
      isInSubmenu: false,
      projectSearchItems: items,
      threadSearchItems: [],
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "project:environment-local:project-1",
    ]);
  });
});

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
        "thread:environment-local:thread-older",
        "thread:environment-local:thread-newer",
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
      "thread:environment-local:thread-title-match",
      "thread:environment-local:thread-context-match",
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

    expect(items.map((item) => item.value)).toEqual(["thread:environment-local:thread-active"]);
  });
});

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
  "https://github.com/pingdotgg/t3code/pull/10839?tab=files#diff-123",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            pullRequest: {
              number: 10839,
              url: "https://github.com/pingdotgg/t3code/pull/10839",
              title: "Find linked PR threads",
              baseBranch: "main",
              headBranch: "feat/search",
              state: "open",
            },
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectTitleById: new Map(),
    sortOrder: "updated_at",
    icon: null,
    runThread: async () => undefined,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
  expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
    "Implementation",
  ]);
});

describe("fuzzy token ranking", () => {
  it("matches typo queries with fuzzy subsequence scoring", () => {
    const items = buildThreadActionItems({
      threads: [makeThread({ title: "Open settings panel" })],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "stngs",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
      "Open settings panel",
    ]);
  });

  it("matches multi-token queries out of order", () => {
    const items = buildProjectActionItems({
      projects: [makeProject({ name: "Web App", cwd: "/Users/example/large project" })],
      valuePrefix: "project",
      icon: () => null,
      runProject: async () => undefined,
    });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project large",
      isInSubmenu: false,
      projectSearchItems: items,
      threadSearchItems: [],
    });
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "project:environment-local:project-1",
    ]);
  });
});

describe("match source and highlight", () => {
  it("labels title versus content matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [makeThread({ title: "Fix navbar spacing" })],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    expect(getPaletteMatchSource(threadItems[0]!, "navbar")).toBe("Title");
    expect(getPaletteMatchSource(threadItems[0]!, "Project")).toBe("Project");

    const transcriptItems = buildTranscriptActionItems({
      matches: [
        {
          environmentId: LOCAL_ENVIRONMENT_ID,
          match: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
            title: "Thread",
            projectTitle: null,
            branch: null,
            role: "user" as const,
            excerpt: "needle in the haystack",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        },
      ],
      metadataGroups: [],
      icon: null,
      runThread: async () => undefined,
    });
    expect(getPaletteMatchSource(transcriptItems[0]!, "needle")).toBe("Content");
  });

  it("splits highlight parts on case-insensitive substrings", () => {
    const parts = splitPaletteHighlightParts("Fix Navbar Spacing", "navbar");
    expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual(["Navbar"]);
  });
});
