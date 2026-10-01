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
  filterPaletteItemsByScopes,
  filterTranscriptMatchesByScopes,
  formatPaletteScopeLabels,
  getPaletteMatchSource,
  isSamePaletteScope,
  parsePaletteScopeQualifiers,
  parseTrailingPaletteScopeQualifier,
  resolvePaletteScopeThreadKeys,
  splitPaletteHighlightParts,
  type CommandPaletteGroup,
  type PaletteScope,
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
  it("finds threads by full or partial ID without fuzzy ID matches", () => {
    const id = ThreadId.make("41cff7ea-f2d9-468b-8a85-7428d5700c78");
    const items = buildThreadActionItems({
      threads: [makeThread({ id, title: "Palette improvements" })],
      projectTitleById: new Map(),
      sortOrder: "created_at",
      icon: null,
      runThread: async () => {},
    });
    for (const query of [id, id.toUpperCase(), "41cff7ea", "7428d5700c78"]) {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: items,
      });
      expect(groups.flatMap((group) => group.items)).toEqual(items);
      expect(getPaletteMatchSource(items[0]!, query)).toBe("ID");
    }
    expect(
      filterCommandPaletteGroups({
        activeGroups: [],
        query: "41cff7ea-f2d9-468b-8a85-7428d5700c79",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: items,
      }),
    ).toEqual([]);
  });
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

  it("badges the best-scoring term when an early field matches weakly", () => {
    const items = buildThreadActionItems({
      threads: [makeThread({ title: "Kickoff notes for the quarterly planning session" })],
      projectTitleById: new Map([[PROJECT_ID, "Planning"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    expect(getPaletteMatchSource(items[0]!, "planning")).toBe("Project");
  });

  it("badges PR matches for full PR URLs with query suffixes", () => {
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
      ],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    expect(
      getPaletteMatchSource(
        items[0]!,
        "https://github.com/pingdotgg/t3code/pull/10839?tab=files#diff-123",
      ),
    ).toBe("PR");
  });
});

describe("palette search scopes", () => {
  const PROJECT_T3 = ProjectId.make("project-t3");
  const PROJECT_OTHER = ProjectId.make("project-other");
  const THREAD_PARENT = ThreadId.make("thread-parent");
  const THREAD_CHILD = ThreadId.make("thread-child");
  const THREAD_GRANDCHILD = ThreadId.make("thread-grandchild");
  const THREAD_SIBLING = ThreadId.make("thread-sibling");

  function makeScopeThreads() {
    return [
      makeThread({ id: THREAD_PARENT, projectId: PROJECT_T3, title: "Parent" }),
      makeThread({
        id: THREAD_CHILD,
        projectId: PROJECT_T3,
        parentThreadId: THREAD_PARENT,
        title: "Child",
      }),
      makeThread({
        id: THREAD_GRANDCHILD,
        projectId: PROJECT_T3,
        parentThreadId: THREAD_CHILD,
        title: "Grandchild",
      }),
      makeThread({ id: THREAD_SIBLING, projectId: PROJECT_OTHER, title: "Sibling" }),
    ];
  }

  function projectScope(): PaletteScope {
    return {
      kind: "project",
      environmentId: LOCAL_ENVIRONMENT_ID,
      projectId: PROJECT_T3,
      label: "T3",
    };
  }

  function threadScope(): PaletteScope {
    return {
      kind: "thread",
      environmentId: LOCAL_ENVIRONMENT_ID,
      threadId: THREAD_PARENT,
      label: "Parent",
    };
  }

  it("resolves project scopes to member threads only", () => {
    const keys = resolvePaletteScopeThreadKeys([projectScope()], makeScopeThreads());
    expect([...keys].toSorted()).toEqual(
      [THREAD_PARENT, THREAD_CHILD, THREAD_GRANDCHILD]
        .map((id) => `thread:${LOCAL_ENVIRONMENT_ID}:${id}`)
        .toSorted(),
    );
  });

  it("resolves thread scopes to the thread plus subthreads", () => {
    const keys = resolvePaletteScopeThreadKeys([threadScope()], makeScopeThreads());
    expect([...keys].toSorted()).toEqual(
      [THREAD_PARENT, THREAD_CHILD, THREAD_GRANDCHILD]
        .map((id) => `thread:${LOCAL_ENVIRONMENT_ID}:${id}`)
        .toSorted(),
    );
  });

  it("includes scope roots absent from the thread list", () => {
    const keys = resolvePaletteScopeThreadKeys([threadScope()], []);
    expect([...keys]).toEqual([`thread:${LOCAL_ENVIRONMENT_ID}:${THREAD_PARENT}`]);
  });

  it("narrows project scopes further when a thread scope is added", () => {
    const keys = resolvePaletteScopeThreadKeys(
      [
        threadScope(),
        {
          kind: "project",
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_OTHER,
          label: "Other",
        },
      ],
      makeScopeThreads(),
    );
    expect([...keys]).toEqual([]);
    expect(
      [
        ...resolvePaletteScopeThreadKeys([projectScope(), threadScope()], makeScopeThreads()),
      ].toSorted(),
    ).toEqual(
      [THREAD_PARENT, THREAD_CHILD, THREAD_GRANDCHILD]
        .map((id) => `thread:${LOCAL_ENVIRONMENT_ID}:${id}`)
        .toSorted(),
    );
  });

  it("filters thread and project rows by scope while keeping actions", () => {
    const threads = makeScopeThreads();
    const threadItems = buildThreadActionItems({
      threads,
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });
    const projectItems = buildProjectActionItems({
      projects: [
        makeProject({ id: PROJECT_T3, name: "T3" }),
        makeProject({ id: PROJECT_OTHER, name: "Other" }),
      ],
      valuePrefix: "project",
      icon: () => null,
      runProject: async () => undefined,
    });
    const actionItem = {
      kind: "action" as const,
      value: "action:settings",
      searchTerms: ["settings"],
      title: "Open settings",
      icon: null,
      run: async () => undefined,
    };
    const filtered = filterPaletteItemsByScopes(
      [...threadItems, ...projectItems, actionItem],
      [projectScope()],
      threads,
    );
    expect(filtered.map((item) => item.value).toSorted()).toEqual(
      [
        `thread:${LOCAL_ENVIRONMENT_ID}:${THREAD_PARENT}`,
        `thread:${LOCAL_ENVIRONMENT_ID}:${THREAD_CHILD}`,
        `thread:${LOCAL_ENVIRONMENT_ID}:${THREAD_GRANDCHILD}`,
        `project:${LOCAL_ENVIRONMENT_ID}:${PROJECT_T3}`,
        "action:settings",
      ].toSorted(),
    );
  });

  it("hides project rows when only a thread scope is active", () => {
    const threads = makeScopeThreads();
    const projectItems = buildProjectActionItems({
      projects: [makeProject({ id: PROJECT_T3, name: "T3" })],
      valuePrefix: "project",
      icon: () => null,
      runProject: async () => undefined,
    });
    expect(filterPaletteItemsByScopes(projectItems, [threadScope()], threads)).toHaveLength(0);
  });

  it("filters transcript matches to scoped threads", () => {
    const matches = [
      {
        environmentId: LOCAL_ENVIRONMENT_ID,
        match: {
          threadId: THREAD_CHILD,
          messageId: MessageId.make("message-child"),
          title: "Child",
          projectTitle: "T3",
          branch: null,
          role: "user" as const,
          excerpt: "needle here",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      },
      {
        environmentId: LOCAL_ENVIRONMENT_ID,
        match: {
          threadId: THREAD_SIBLING,
          messageId: MessageId.make("message-sibling"),
          title: "Sibling",
          projectTitle: "Other",
          branch: null,
          role: "user" as const,
          excerpt: "needle there",
          updatedAt: "2026-09-10T00:00:00.000Z",
        },
      },
    ];
    const filtered = filterTranscriptMatchesByScopes(matches, [threadScope()], makeScopeThreads());
    expect(filtered.map((item) => item.match.threadId)).toEqual([THREAD_CHILD]);
  });

  it("parses leading project qualifiers into chips", () => {
    const projects = [makeProject({ id: PROJECT_T3, name: "T3" })];
    const parsed = parsePaletteScopeQualifiers("project:t3 rest of query", projects, []);
    expect(parsed.scopes).toEqual([projectScope()]);
    expect(parsed.text).toBe("rest of query");
  });

  it("parses quoted qualifier values with spaces", () => {
    const projects = [makeProject({ id: PROJECT_T3, name: "My Project" })];
    const parsed = parsePaletteScopeQualifiers('project:"My Project" rest', projects, []);
    expect(parsed.scopes).toEqual([
      {
        kind: "project",
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_T3,
        label: "My Project",
      },
    ]);
    expect(parsed.text).toBe("rest");
  });

  it("leaves unresolvable qualifiers as text", () => {
    const parsed = parsePaletteScopeQualifiers("project:zzz rest", [], []);
    expect(parsed.scopes).toEqual([]);
    expect(parsed.text).toBe("project:zzz rest");
  });

  it("does not consume a qualifier still being typed", () => {
    const projects = [makeProject({ id: PROJECT_T3, name: "T3" })];
    const parsed = parsePaletteScopeQualifiers("project:t", projects, []);
    expect(parsed.scopes).toEqual([]);
    expect(parsed.text).toBe("project:t");
  });

  it("commits a lone qualifier for Tab", () => {
    const projects = [makeProject({ id: PROJECT_T3, name: "T3" })];
    expect(parseTrailingPaletteScopeQualifier("project:t3", projects, [])).toEqual(projectScope());
    expect(parseTrailingPaletteScopeQualifier("some project:t3", projects, [])).toBeNull();
  });

  it("compares and labels scopes", () => {
    expect(isSamePaletteScope(projectScope(), projectScope())).toBe(true);
    expect(isSamePaletteScope(projectScope(), threadScope())).toBe(false);
    expect(formatPaletteScopeLabels([projectScope(), threadScope()])).toBe("T3, Parent");
  });
});
