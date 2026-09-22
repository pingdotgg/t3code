import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode, Ref } from "react";
import type { ConfirmDialogOptions } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type CapturedButtonClick = (event: unknown) => unknown;

type CapturedProjectFaviconProps = ComponentProps<
  typeof import("../ProjectFavicon").ProjectFavicon
>;

const testDoubles = vi.hoisted(() => ({
  inputRef: null as Ref<HTMLInputElement> | null,
  archiveSearchQueryOverride: null as string | null,
  navigate: vi.fn(),
  confirm: vi.fn(async (_message: string, _options?: ConfirmDialogOptions) => false),
  contextMenu: vi.fn(),
  contextMenuResult: null as string | null,
  deleteThread: vi.fn(),
  unarchiveThread: vi.fn(),
  discardComposerDraft: vi.fn(),
  refreshArchivedThreadsForEnvironment: vi.fn(),
  deleteThreadCommand: {},
  unarchiveThreadCommand: {},
  toastAdd: vi.fn(),
  buttonClicks: new Map<string, CapturedButtonClick[]>(),
  projectFaviconProps: [] as CapturedProjectFaviconProps[],
  archiveState: {
    snapshots: [] as ReadonlyArray<unknown>,
    error: null as string | null,
    isLoading: false,
    refresh: vi.fn(),
  },
}));

vi.mock("./ArchiveSettings.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ArchiveSettings.logic")>();
  return {
    ...actual,
    parseArchivedThreadSearchInput: (query: string) =>
      actual.parseArchivedThreadSearchInput(testDoubles.archiveSearchQueryOverride ?? query),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (location: { hash: string; state: { settingsTargetHighlight: boolean } }) => unknown;
  }) => select({ hash: "#archive", state: { settingsTargetHighlight: true } }),
  useNavigate: () => testDoubles.navigate,
}));

vi.mock("../ui/input", () => ({
  Input: ({
    ref,
    nativeInput: _nativeInput,
    ...inputProps
  }: ComponentProps<"input"> & { nativeInput?: boolean; ref?: Ref<HTMLInputElement> }) => {
    testDoubles.inputRef = ref ?? null;
    return <input {...inputProps} />;
  },
}));

vi.mock("../ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/button")>();
  return {
    ...actual,
    Button: ({
      children,
      onClick,
      ...buttonProps
    }: ComponentProps<"button"> & { onClick?: CapturedButtonClick }) => {
      const label = buttonProps["aria-label"];
      if (typeof label === "string" && onClick) {
        const clicks = testDoubles.buttonClicks.get(label) ?? [];
        clicks.push(onClick);
        testDoubles.buttonClicks.set(label, clicks);
      }
      return <button {...buttonProps}>{children}</button>;
    },
  };
});

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: (props: CapturedProjectFaviconProps) => {
    testDoubles.projectFaviconProps.push(props);
    return <span data-project-favicon />;
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    selector({ confirmThreadDelete: true }),
  usePrimarySettingsAvailable: () => true,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    delete: testDoubles.deleteThreadCommand,
    unarchive: testDoubles.unarchiveThreadCommand,
  },
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: ["environment-1"], members: [] },
  }),
  useOptionalSettingsScope: () => null,
}));

vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === testDoubles.deleteThreadCommand) return testDoubles.deleteThread;
    if (command === testDoubles.unarchiveThreadCommand) return testDoubles.unarchiveThread;
    throw new Error("Unexpected archive command");
  },
}));

vi.mock("../../lib/composerDraftUploads", () => ({
  discardComposerDraft: testDoubles.discardComposerDraft,
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testDoubles.toastAdd },
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    dialogs: {
      confirm: testDoubles.confirm,
    },
    contextMenu: {
      show: (...args: ReadonlyArray<unknown>) => {
        testDoubles.contextMenu(...args);
        return Promise.resolve(testDoubles.contextMenuResult);
      },
    },
  }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: testDoubles.refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots: () => ({
    snapshots: testDoubles.archiveState.snapshots,
    error: testDoubles.archiveState.error,
    isLoading: testDoubles.archiveState.isLoading,
    refresh: testDoubles.archiveState.refresh,
  }),
}));

import { ArchivedThreadsPanel } from "./ArchiveSettings";

afterEach(() => {
  testDoubles.inputRef = null;
  testDoubles.archiveSearchQueryOverride = null;
  testDoubles.navigate.mockReset();
  testDoubles.confirm.mockClear();
  testDoubles.contextMenu.mockClear();
  testDoubles.contextMenuResult = null;
  testDoubles.deleteThread.mockReset();
  testDoubles.unarchiveThread.mockReset();
  testDoubles.discardComposerDraft.mockReset();
  testDoubles.refreshArchivedThreadsForEnvironment.mockReset();
  testDoubles.toastAdd.mockReset();
  testDoubles.buttonClicks.clear();
  testDoubles.projectFaviconProps.length = 0;
  testDoubles.archiveState.snapshots = [];
  testDoubles.archiveState.error = null;
  testDoubles.archiveState.isLoading = false;
  testDoubles.archiveState.refresh.mockReset();
  vi.unstubAllGlobals();
});

const populatedArchiveSnapshots = [
  {
    environmentId: "environment-1",
    snapshot: {
      snapshotSequence: 1,
      projects: [
        {
          id: "project-1",
          title: "Archive project",
          workspaceRoot: "/workspaces/archive-project",
          faviconPath: "/workspaces/archive-project/.t3/favicon.svg",
          projectIcon: { kind: "emoji", emoji: "🧪" },
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Archived conversation",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
          archivedAt: "2026-06-02T00:00:00.000Z",
          session: null,
          latestUserMessageAt: null,
          settledOverride: null,
          settledAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  },
] as const;

function renderPopulatedArchive(searchQuery?: string) {
  testDoubles.archiveState.snapshots = populatedArchiveSnapshots;
  testDoubles.archiveSearchQueryOverride = searchQuery ?? null;
  return renderToStaticMarkup(<ArchivedThreadsPanel />);
}

function clickCapturedButton(label: string, currentTarget: unknown = {}) {
  const clicks = testDoubles.buttonClicks.get(label) ?? [];
  if (clicks.length !== 1) {
    throw new Error(`Expected exactly one ${label} button, received ${clicks.length}`);
  }
  const onClick = clicks[0]!;
  onClick({ currentTarget, stopPropagation: vi.fn() });
}

describe("ArchivedThreadsPanel", () => {
  it("forwards archived project icon metadata to ProjectFavicon", () => {
    renderPopulatedArchive();

    expect(testDoubles.projectFaviconProps).toEqual([
      {
        project: expect.objectContaining({
          ...populatedArchiveSnapshots[0].snapshot.projects[0],
          environmentId: "environment-1",
        }),
      },
    ]);
  });

  it.each([
    {
      archiveState: { snapshots: [], isLoading: false },
      expectedContent: "No archived threads",
      state: "empty",
    },
    {
      archiveState: { snapshots: [], isLoading: true },
      expectedContent: "Loading archived threads",
      state: "loading",
    },
    {
      archiveState: {
        snapshots: populatedArchiveSnapshots,
        isLoading: false,
      },
      expectedContent: "Archive project",
      state: "populated",
    },
  ])(
    "focuses the persistent archive search field in the $state state",
    ({ archiveState, expectedContent }) => {
      testDoubles.archiveState.snapshots = archiveState.snapshots;
      testDoubles.archiveState.isLoading = archiveState.isLoading;
      const scrollIntoView = vi.fn();
      const focus = vi.fn();
      const classList = { remove: vi.fn(), add: vi.fn() };
      const addEventListener = vi.fn();
      vi.stubGlobal("window", {
        matchMedia: vi.fn(() => ({ matches: false })),
      });

      const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);
      const archiveInput = {
        tagName: "INPUT",
        firstElementChild: null,
        scrollIntoView,
        focus,
        classList,
        addEventListener,
        offsetWidth: 100,
      } as unknown as HTMLInputElement;

      if (typeof testDoubles.inputRef !== "function") {
        throw new Error("Expected the archive input to receive a callback ref");
      }
      testDoubles.inputRef(archiveInput);

      expect(markup).toContain('id="archive"');
      expect(markup).toContain('aria-label="Search archived conversations"');
      expect(markup).toContain(expectedContent);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(classList.remove).toHaveBeenCalledWith("settings-search-target-pulse");
      expect(classList.add).toHaveBeenCalledWith("settings-search-target-pulse");
      expect(testDoubles.navigate).toHaveBeenCalledWith({
        hash: "",
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
  );

  it("shows partial archive failures above loaded groups and retries them", () => {
    testDoubles.archiveState.snapshots = populatedArchiveSnapshots;
    testDoubles.archiveState.error = "Remote archive unavailable";

    const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);

    expect(markup).toContain("Could not load every archive");
    expect(markup).toContain("Remote archive unavailable");
    expect(markup).toContain("Archive project");

    clickCapturedButton("Try again to load archives");

    expect(testDoubles.archiveState.refresh).toHaveBeenCalledOnce();
  });

  it("shows the retry alert when every archive fails", () => {
    testDoubles.archiveState.error = "Every archive is unavailable";

    const markup = renderToStaticMarkup(<ArchivedThreadsPanel />);

    expect(markup).toContain("Could not load every archive");
    expect(markup).toContain("Every archive is unavailable");
    expect(markup).not.toContain("Could not load archived threads");

    clickCapturedButton("Try again to load archives");

    expect(testDoubles.archiveState.refresh).toHaveBeenCalledOnce();
  });

  it("requests a destructive confirmation for a single archived-thread delete", async () => {
    // Searching expands the project so its row actions are rendered.
    renderPopulatedArchive("Archived");

    clickCapturedButton("Delete");

    await vi.waitFor(() => {
      expect(testDoubles.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Delete archived conversation "Archived conversation"?'),
        { variant: "destructive" },
      );
    });
  });

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      buttonLabel: "Unarchive",
      confirm: false,
    },
    {
      action: () => testDoubles.deleteThread,
      buttonLabel: "Delete",
      confirm: true,
    },
  ])(
    "refreshes after a successful single $buttonLabel",
    async ({ action, buttonLabel, confirm }) => {
      action().mockResolvedValueOnce({ _tag: "Success", value: undefined });
      if (confirm) testDoubles.confirm.mockResolvedValueOnce(true);
      renderPopulatedArchive("Archived");

      clickCapturedButton(buttonLabel);

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledWith({
          environmentId: "environment-1",
          input: { threadId: "thread-1" },
        });
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      buttonLabel: "Unarchive",
      title: "Failed to unarchive thread",
    },
    {
      action: () => testDoubles.deleteThread,
      buttonLabel: "Delete",
      title: "Failed to delete thread",
    },
  ])("reports an unexpected $buttonLabel rejection", async ({ action, buttonLabel, title }) => {
    const error = new Error(`${buttonLabel} rejected`);
    action().mockRejectedValueOnce(error);
    if (buttonLabel === "Delete") {
      testDoubles.confirm.mockResolvedValueOnce(true);
    }
    renderPopulatedArchive("Archived");

    clickCapturedButton(buttonLabel);

    await vi.waitFor(() => {
      expect(testDoubles.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title,
        description: error.message,
      });
      expect(testDoubles.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
      expect(testDoubles.archiveState.refresh).not.toHaveBeenCalled();
    });
  });

  it("cleans up composer uploads and draft state after deleting an archived thread", async () => {
    testDoubles.deleteThread.mockResolvedValueOnce({ _tag: "Success", value: undefined });
    testDoubles.confirm.mockResolvedValueOnce(true);
    renderPopulatedArchive("Archived");

    clickCapturedButton("Delete");

    const threadRef = { environmentId: "environment-1", threadId: "thread-1" };
    await vi.waitFor(() => {
      expect(testDoubles.discardComposerDraft).toHaveBeenCalledWith(threadRef);
    });
  });

  it("exposes the active archive sort direction in the button label", () => {
    const markup = renderPopulatedArchive("Archived");

    expect(markup).toContain('aria-label="Sort by Archived, descending"');
    expect(markup).toContain('aria-label="Sort by Created"');
    expect(markup).not.toContain("aria-sort");
  });

  it("reveals row actions for keyboard focus without pinning mouse focus", () => {
    const markup = renderPopulatedArchive("Archived");

    expect(markup).toContain("has-[:focus-visible]:bg-accent");
    expect(markup).toContain("group-has-[:focus-visible]:opacity-100");
    expect(markup).not.toContain("focus-within");
  });

  it("requests a destructive confirmation for a project bulk delete", async () => {
    testDoubles.contextMenuResult = "delete-all";
    renderPopulatedArchive();

    clickCapturedButton("Project actions for Archive project", {
      getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
    });

    await vi.waitFor(() => {
      expect(testDoubles.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Delete all archived conversations in "Archive project"?'),
        { variant: "destructive" },
      );
    });
  });

  it("keeps project bulk unarchive on the default confirmation variant", async () => {
    testDoubles.contextMenuResult = "unarchive-all";
    renderPopulatedArchive();

    clickCapturedButton("Project actions for Archive project", {
      getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
    });

    await vi.waitFor(() => expect(testDoubles.confirm).toHaveBeenCalled());
    const [message, options] = testDoubles.confirm.mock.calls[0]!;
    expect(message).toContain('Unarchive all archived conversations in "Archive project"?');
    expect(options?.variant).not.toBe("destructive");
  });

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      contextMenuResult: "unarchive-all",
    },
    {
      action: () => testDoubles.deleteThread,
      contextMenuResult: "delete-all",
    },
  ])(
    "refreshes once after a successful $contextMenuResult project action",
    async ({ action, contextMenuResult }) => {
      testDoubles.contextMenuResult = contextMenuResult;
      testDoubles.confirm.mockResolvedValueOnce(true);
      action().mockResolvedValueOnce({ _tag: "Success", value: undefined });
      renderPopulatedArchive();

      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );

  it.each([
    {
      action: () => testDoubles.unarchiveThread,
      contextMenuResult: "unarchive-all",
    },
    {
      action: () => testDoubles.deleteThread,
      contextMenuResult: "delete-all",
    },
  ])(
    "refreshes once after a throwing $contextMenuResult project action",
    async ({ action, contextMenuResult }) => {
      testDoubles.contextMenuResult = contextMenuResult;
      testDoubles.confirm.mockResolvedValueOnce(true);
      action().mockRejectedValueOnce(new Error(`${contextMenuResult} rejected`));
      renderPopulatedArchive();

      clickCapturedButton("Project actions for Archive project", {
        getBoundingClientRect: () => ({ right: 80, bottom: 40 }),
      });

      await vi.waitFor(() => {
        expect(action()).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
        expect(testDoubles.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
          "environment-1",
        );
      });
    },
  );
});
