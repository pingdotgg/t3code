import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildBrowseGroups,
  buildImportSessionProviderOptions,
  buildThreadActionItems,
  describeImportSessionStep,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: "ToggleMode",
      mode: "content",
    });
    expect(contentOpen).toEqual({ open: true, mode: "content", openIntent: null });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: "ToggleMode", mode: "content" }),
    ).toEqual({ open: false, mode: "command", openIntent: null });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("resets to command mode for dialog-driven opens and closes", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "command",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

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

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("T3 Code · #feat/search");
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

describe("buildBrowseGroups", () => {
  it("waits for asynchronous browse navigation actions", async () => {
    let finishNavigation: (() => void) | undefined;
    const browseTo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const groups = buildBrowseGroups({
      browseEntries: [{ name: "Downloads", fullPath: "/Users/test/Downloads" }],
      browseQuery: "~/",
      canBrowseUp: false,
      upIcon: null,
      directoryIcon: null,
      browseUp: vi.fn(),
      browseTo,
    });
    const item = groups[0]?.items[0];
    if (!item || item.kind !== "action") {
      throw new Error("Expected a browse action");
    }

    let actionSettled = false;
    const action = item.run().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();

    expect(browseTo).toHaveBeenCalledWith("Downloads");
    expect(actionSettled).toBe(false);

    finishNavigation?.();
    await action;
    expect(actionSettled).toBe(true);
  });
});

function provider(input: {
  driver: string;
  instanceId: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const providerModel = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: {} });

describe("buildImportSessionProviderOptions", () => {
  it("offers Claude and Codex with their own field labels and default models", () => {
    const options = buildImportSessionProviderOptions([
      provider({
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        models: [providerModel("sonnet")],
      }),
      provider({ driver: "codex", instanceId: "codex", models: [providerModel("gpt-5-codex")] }),
    ]);

    expect(options).toEqual([
      {
        driverKind: "claudeAgent",
        label: "Claude Code",
        fieldLabel: "Session ID",
        placeholder: "0de413a1-1796-43c7-9abf-967c5aedd890",
        hint: "Run /status inside a Claude Code session to copy its id, or pick one from claude --resume.",
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
      },
      {
        driverKind: "codex",
        label: "Codex",
        fieldLabel: "Thread ID",
        placeholder: "019a2f8c-4e1b-7c3d-9f10-2b6a5d8e4c77",
        hint: "Run codex resume to list thread ids.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      },
    ]);
  });

  it("drops providers that are not ready and providers this feature does not support", () => {
    const options = buildImportSessionProviderOptions([
      provider({
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        status: "error",
        models: [providerModel("sonnet")],
      }),
      provider({ driver: "cursor", instanceId: "cursor", models: [providerModel("auto")] }),
      provider({ driver: "codex", instanceId: "codex", models: [providerModel("gpt-5-codex")] }),
    ]);

    expect(options.map((option) => option.driverKind)).toEqual(["codex"]);
  });
});

describe("describeImportSessionStep", () => {
  it("imports straight away before the session is resolved", () => {
    expect(describeImportSessionStep(null)).toEqual({
      notice: null,
      confirmLabel: "Import",
      missingProjectWorkspaceRoot: null,
    });
  });

  it("imports straight away once the session maps to an existing project", () => {
    expect(
      describeImportSessionStep({
        externalId: "session-1",
        workspaceRoot: "/home/dev/app",
        projectId: PROJECT_ID,
        title: "Fix the flaky test",
      }),
    ).toEqual({ notice: null, confirmLabel: "Import", missingProjectWorkspaceRoot: null });
  });

  it("asks to add the workspace when no project matches it", () => {
    expect(
      describeImportSessionStep({
        externalId: "session-1",
        workspaceRoot: "/home/dev/app",
        projectId: null,
        title: null,
      }),
    ).toEqual({
      notice: "This session ran in /home/dev/app, which is not a project yet.",
      confirmLabel: "Add project & import",
      missingProjectWorkspaceRoot: "/home/dev/app",
    });
  });

  it("imports into the current project when the provider reports no workspace", () => {
    expect(
      describeImportSessionStep({
        externalId: "thread-1",
        workspaceRoot: null,
        projectId: null,
        title: null,
      }),
    ).toEqual({ notice: null, confirmLabel: "Import", missingProjectWorkspaceRoot: null });
  });
});
