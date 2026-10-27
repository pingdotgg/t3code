import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildNestedSearchItems,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  resolveAddProjectEntry,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
  type CommandPaletteUiState,
} from "./CommandPalette.logic";

describe("linked pull request thread navigation", () => {
  it("keeps archived relations searchable and routes them through the PR environment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const id = ThreadId.make("archived-thread");
    const runThread = vi.fn(async () => {});
    const query = "https://github.com/acme/web/pull/42";
    const linkedThreads = {
      environmentId,
      threads: [
        {
          id,
          projectId: ProjectId.make("project"),
          title: "Completed work",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const state = reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null, session: 0 },
      {
        _tag: "OpenSearch",
        query,
        linkedThreads,
      },
    );
    expect(state.openIntent).toEqual({ kind: "search", query, linkedThreads });
    const items = buildLinkedThreadActionItems({ ...linkedThreads, query, icon: null, runThread });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items)).toEqual(items);
    expect(items[0]?.description).toBe("Archived thread");
    await items[0]?.run();
    expect(runThread).toHaveBeenCalledWith({ environmentId, id });
  });
});

describe("reduceCommandPaletteUiState", () => {
  it("opens PR search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null, session: 0 },
      {
        _tag: "OpenSearch",
        query: "https://github.com/acme/web/pull/7",
      },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "https://github.com/acme/web/pull/7" },
      session: 1,
    });
    const second = reduceCommandPaletteUiState(first, {
      _tag: "OpenSearch",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(second.openIntent).toEqual({
      kind: "search",
      query: "https://github.com/acme/web/pull/8",
    });
    // The second intent starts a new session, so the open palette starts over from it.
    expect(second.session).toBe(2);
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });

  it("keeps the session across mode switches so only intents start the palette over", () => {
    let state: CommandPaletteUiState = {
      open: false,
      mode: "command",
      openIntent: null,
      session: 0,
    };
    state = reduceCommandPaletteUiState(state, { _tag: "OpenNewThreadIn" });
    expect(state).toMatchObject({ open: true, openIntent: { kind: "new-thread-in" }, session: 1 });
    state = reduceCommandPaletteUiState(state, { _tag: "ToggleMode", mode: "files" });
    expect(state).toMatchObject({ mode: "files", openIntent: null, session: 1 });
    state = reduceCommandPaletteUiState(state, { _tag: "OpenAddProject" });
    expect(state).toMatchObject({
      mode: "command",
      openIntent: { kind: "add-project" },
      session: 2,
    });
  });
});

describe("resolveAddProjectEntry", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");

  it("sends the user to connect an environment when none can add a project", () => {
    expect(resolveAddProjectEntry([], null)).toEqual({ kind: "connect-environment" });
  });

  it("asks for an environment when there is a choice or no connected default", () => {
    expect(
      resolveAddProjectEntry([{ environmentId: local }, { environmentId: remote }], local),
    ).toEqual({ kind: "choose-environment" });
    expect(resolveAddProjectEntry([{ environmentId: local }], null)).toEqual({
      kind: "choose-environment",
    });
  });

  it("goes straight to sources for the only environment", () => {
    expect(resolveAddProjectEntry([{ environmentId: local }], local)).toEqual({
      kind: "choose-source",
      environmentId: local,
    });
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("buildThreadActionItems", () => {
  it("keeps threads apart when two environments share a thread ID", async () => {
    const local = makeThread();
    const remote = makeThread({ environmentId: EnvironmentId.make("remote-copy") });
    const runThread = vi.fn(async () => {});
    const items = buildThreadActionItems({
      threads: [local, remote],
      activeThread: remote,
      projectByKey: new Map([
        [`${local.environmentId}:${local.projectId}`, { title: "Local project" }],
        [`${remote.environmentId}:${remote.projectId}`, { title: "Remote project" }],
      ]),
      icon: null,
      runThread,
    });
    expect(new Set(items.map((item) => item.value)).size).toBe(2);
    const remoteItem = items.find((item) => item.description === "Remote project · Current thread");
    await remoteItem?.run();
    expect(runThread).toHaveBeenCalledWith(remote);
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
      projectByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, { title: "Project" }]]),
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

  it("searches submenu options from the root and from a submenu with no match", () => {
    const action = (value: string, title: string) => ({
      kind: "action" as const,
      value,
      searchTerms: [title],
      title,
      icon: null,
      run: async () => undefined,
    });
    const projects = [action("new-thread-in:t3code", "t3code"), action("new-thread-in:web", "web")];
    const newThreadIn = {
      kind: "submenu" as const,
      value: "action:new-thread-in",
      searchTerms: ["new thread"],
      title: "New thread in...",
      icon: null,
      addonIcon: null,
      groups: [{ value: "projects", label: "Projects", items: projects }],
    };
    const addProject = action("action:add-project", "Add project");
    const rootGroups = [{ value: "actions", label: "Actions", items: [newThreadIn, addProject] }];
    const search = (query: string, isInSubmenu: boolean) =>
      filterCommandPaletteGroups({
        activeGroups: isInSubmenu ? newThreadIn.groups : rootGroups,
        query,
        isInSubmenu,
        allOptions: {
          rootGroups,
          nestedItems: buildNestedSearchItems([newThreadIn, addProject], query),
        },
        projectSearchItems: [],
        threadSearchItems: [
          ...buildThreadActionItems({
            threads: [makeThread({ title: "Thread about t3code" })],
            projectByKey: new Map(),
            icon: null,
            runThread: async () => undefined,
          }),
        ],
      }).map((group) => [group.label, group.items.map((item) => item.title)]);

    expect(search("new thread in t3code", false)[0]).toEqual([
      "Suggestions",
      ["New thread in t3code"],
    ]);
    expect(search("new thread", false).map(([label]) => label)).not.toContain("Suggestions");
    expect(search("t3", true)).toEqual([["Projects", ["t3code"]]]);
    expect(search("add project", true)).toEqual([["Actions", ["Add project"]]]);
  });

  it("lists message matches last, once, without moving the title matches above them", () => {
    const threads = [
      makeThread({ id: ThreadId.make("title"), title: "Disable Convex schema validation" }),
      makeThread({ id: ThreadId.make("message"), title: "Fix schema validation" }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const filter = (threadMessageItems: typeof items) =>
      filterCommandPaletteGroups({
        activeGroups: [],
        query: "convex",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: items,
        threadMessageItems,
      }).map((group) => [group.label, group.items.map((item) => item.value)]);

    const before = filter([]);
    // The server matched both; the title match stays where it was.
    const after = filter([items[0]!, items[1]!].toReversed());
    expect(before).toEqual([["Threads", ["thread:environment-local:title"]]]);
    expect(after).toEqual([
      ["Threads", ["thread:environment-local:title"]],
      ["In messages", ["thread:environment-local:message"]],
    ]);
  });

  it("keeps an active thread first while its title is typed, above settings and actions", () => {
    const now = Date.parse("2026-10-23T00:00:00.000Z");
    const action = (value: string, title: string, searchTerms: string[] = [title]) => ({
      kind: "action" as const,
      value,
      searchTerms,
      title,
      icon: null,
      run: async () => undefined,
    });
    const threadSearchItems = buildThreadActionItems({
      threads: [
        makeThread({
          title: "Compaction prompt timing and cache age",
          latestUserMessageAt: "2026-10-11T00:00:00.000Z",
        }),
      ],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const firstGroup = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: [
          { value: "actions", label: "Actions", items: [action("action:copy", "Copy thread ID")] },
        ],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        settingsSearchItems: [
          action("setting:compact", "Compact idle threads"),
          action("setting:providers", "Providers", ["Providers", "compatibility"]),
        ],
        threadSearchItems,
        now,
      })[0]?.label;

    for (const query of ["comp", "compa", "compac", "compact", "compacti", "compaction"]) {
      expect(firstGroup(query), query).toBe("Threads");
    }
  });

  it("orders groups by their best match, so a strong thread is not under a weak action", () => {
    const action = (value: string, title: string) => ({
      kind: "action" as const,
      value,
      searchTerms: [title],
      title,
      icon: null,
      run: async () => undefined,
    });
    const threadSearchItems = buildThreadActionItems({
      threads: [makeThread({ title: "Upgrade to pnpm 12" })],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const labels = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: [
          { value: "actions", label: "Actions", items: [action("action:upload", "Upload file")] },
        ],
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems,
      }).map((group) => group.label);

    expect(labels("upgrade")).toEqual(["Threads"]);
    expect(labels("upl")).toEqual(["Actions"]);
    // A short query still finds a command by a keyword it equals.
    const prGroups = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            {
              kind: "action",
              value: "action:open-prs",
              searchTerms: ["Open pull requests", "pr", "prs", "review"],
              title: "Open pull requests",
              icon: null,
              run: async () => undefined,
            },
            action("action:project", "Project settings"),
          ],
        },
      ],
      query: "pr",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });
    expect(prGroups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "action:open-prs",
      "action:project",
    ]);
    expect(labels("up")).toEqual(["Actions", "Threads"]);
    expect(labels("pnpm up")).toEqual(["Threads"]);
  });

  it("runs the command for its whole name over a thread with that title, and lists the open thread last", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-new"), title: "New thread" }),
      makeThread({ id: ThreadId.make("thread-open"), title: "New thread layout" }),
      makeThread({ id: ThreadId.make("thread-other"), title: "New thread button" }),
    ];
    const threadSearchItems = buildThreadActionItems({
      threads,
      activeThread: threads[1]!,
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            {
              kind: "action",
              value: "action:new-thread",
              searchTerms: ["New thread in t3code"],
              title: "New thread in t3code",
              icon: null,
              run: async () => undefined,
            },
          ],
        },
      ],
      query: "new thread",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems,
    });
    expect(groups.map((group) => group.label)).toEqual(["Actions", "Threads"]);
    expect(groups[1]?.items.at(-1)?.title).toBe("New thread layout");
  });

  it("lists a project above threads that only hold its name when the name is typed", () => {
    const threadSearchItems = buildThreadActionItems({
      threads: [makeThread({ title: "Lakebed performance gains" })],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const projectSearchItems = [
      {
        kind: "action" as const,
        value: "project:lakebed",
        searchTerms: ["Lakebed", "/code/lakebed"],
        title: "Lakebed",
        icon: null,
        run: async () => undefined,
      },
    ];
    const labels = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: [],
        query,
        isInSubmenu: false,
        projectSearchItems,
        threadSearchItems,
      }).map((group) => group.label);
    expect(labels("lakebed")).toEqual(["Projects", "Threads"]);
    expect(labels("lake")).toEqual(["Threads", "Projects"]);
  });

  it("keeps a command first over a thread in daily use that matches as well", () => {
    const now = Date.parse("2026-10-23T00:00:00.000Z");
    const threadSearchItems = buildThreadActionItems({
      threads: [
        makeThread({
          title: "New onboarding flow",
          latestUserMessageAt: "2026-10-22T00:00:00.000Z",
          opens: { openedAt: Date.parse("2026-10-22T00:00:00.000Z"), score: 7, picks: [] },
        }),
      ],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            {
              kind: "action",
              value: "action:new-thread",
              searchTerms: ["new thread", "chat"],
              title: "New thread",
              icon: null,
              run: async () => undefined,
            },
          ],
        },
      ],
      query: "new",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems,
      now,
    });
    expect(groups.map((group) => group.label)).toEqual(["Actions", "Threads"]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("searches a styled command title by its plain text", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            {
              kind: "action",
              value: "action:new-thread",
              searchTerms: ["new thread", "chat"],
              // Styled: not a string, so only `searchTitle` holds its words.
              title: ["New thread in ", "t3code"],
              searchTitle: "New thread in t3code",
              icon: null,
              run: async () => undefined,
            },
          ],
        },
      ],
      query: "> new t3code",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });
    expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "action:new-thread",
    ]);
  });

  it("forgives a typo in a setting name when nothing matches exactly", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "keybindngs",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
      settingsSearchItems: [
        {
          kind: "action",
          value: "setting:keybindings",
          title: "Keybindings",
          searchTerms: ["Keybindings", "General", "shortcuts"],
          icon: null,
          run: async () => undefined,
        },
      ],
    });
    expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
      "setting:keybindings",
    ]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectByKey: new Map([[`${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`, { title: "T3 Code" }]]),
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${LOCAL_ENVIRONMENT_ID}:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${LOCAL_ENVIRONMENT_ID}:${idThread.id}` }),
    ]);
  });

  it("hides subagent threads but keeps forks", () => {
    const parentId = ThreadId.make("parent");
    const items = buildThreadActionItems({
      threads: [
        makeThread({ id: parentId, title: "Parent" }),
        makeThread({
          id: ThreadId.make("subagent"),
          title: "Subagent",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
        makeThread({
          id: ThreadId.make("fork"),
          title: "Fork",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "fork",
          },
        }),
      ],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });

    expect(items.map((item) => item.value).toSorted()).toEqual([
      "thread:environment-local:fork",
      "thread:environment-local:parent",
    ]);
  });

  it("ranks word-start title matches above newer mid-word matches", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("mid-word"),
          title: "Fix oauth redirect",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("word-start"),
          title: "Clean up auth tokens",
          updatedAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("branch-word-start"),
          title: "Refactor login",
          branch: "feature/auth-cleanup",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "auth",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:environment-local:word-start",
      "thread:environment-local:branch-word-start",
      "thread:environment-local:mid-word",
    ]);
  });

  it("breaks ties between equal matches by latest user message", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("prefix-stale"),
          title: "Auth refactor",
          updatedAt: "2026-03-20T00:00:00.000Z",
          latestUserMessageAt: "2025-09-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("word-fresh"),
          title: "Fix auth refresh",
          updatedAt: "2026-03-10T00:00:00.000Z",
          latestUserMessageAt: "2026-03-10T00:00:00.000Z",
        }),
      ],
      projectByKey: new Map(),
      icon: null,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "auth",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
      now: Date.parse("2026-03-20T00:00:00.000Z"),
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:environment-local:word-fresh",
      "thread:environment-local:prefix-stale",
    ]);
  });
});

describe("filterPinnedBrowseEntries", () => {
  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectByKey: new Map(),
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

describe("command palette search return", () => {
  const picker = { addonIcon: null, groups: [] };

  it("restores each parent query when backing out of nested pickers", () => {
    let state = createCommandPaletteSearchState(">new thread");
    state = reduceCommandPaletteSearchState(state, { type: "push", view: picker });
    expect(state.query).toBe("");
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "remote project" });
    state = reduceCommandPaletteSearchState(state, {
      type: "push",
      view: { ...picker, initialQuery: "~/" },
    });
    expect(state.query).toBe("~/");

    state = reduceCommandPaletteSearchState(state, { type: "query", query: "" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("remote project");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe(">new thread");
    expect(state.views).toHaveLength(0);
  });

  it("cannot return to an old picker after a new search replaces it", () => {
    let state = reduceCommandPaletteSearchState(createCommandPaletteSearchState("old"), {
      type: "push",
      view: picker,
    });
    state = reduceCommandPaletteSearchState(state, { type: "reset", query: "fresh" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("fresh");
    expect(state.views).toHaveLength(0);
  });
});

describe("returning from file and content search", () => {
  const root: CommandPaletteUiState = {
    open: true,
    mode: "command",
    openIntent: null,
    session: 0,
  };
  const query = "https://github.com/acme/web/pull/7";
  const context = {
    query,
    linkedThreadSearch: {
      kind: "search" as const,
      query,
      linkedThreads: {
        environmentId: EnvironmentId.make("remote"),
        threads: [
          {
            id: ThreadId.make("linked-thread"),
            projectId: ProjectId.make("project"),
            title: "Completed work",
            archivedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  it.each(["files", "content"] as const)(
    "Escape from %s restores the query and linked-thread results",
    (mode) => {
      const child = reduceCommandPaletteUiState(root, { _tag: "OpenChildSearch", mode, context });
      expect(child.mode).toBe(mode);
      const returned = reduceCommandPaletteUiState(child, { _tag: "BackToCommand" });
      expect(returned).toEqual({ ...root, restoredSearch: context });
      expect(reduceCommandPaletteUiState(returned, { _tag: "BackToCommand" })).toEqual(returned);
    },
  );

  it("closing a child search discards its return context before reopening", () => {
    const child: CommandPaletteUiState = { ...root, mode: "files", parentSearch: context };
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed).toEqual({ open: false, mode: "files", openIntent: null, session: 0 });
    expect(reduceCommandPaletteUiState(closed, { _tag: "BackToCommand" })).toEqual(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual(root);
  });
});
