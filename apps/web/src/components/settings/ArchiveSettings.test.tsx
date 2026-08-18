import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode, Ref } from "react";
import type { ConfirmDialogOptions } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type CapturedButtonClick = (event: unknown) => unknown;

const testDoubles = vi.hoisted(() => ({
  inputRef: null as Ref<HTMLInputElement> | null,
  archiveSearchQueryOverride: null as string | null,
  navigate: vi.fn(),
  confirm: vi.fn(async (_message: string, _options?: ConfirmDialogOptions) => false),
  contextMenu: vi.fn(),
  contextMenuResult: null as string | null,
  buttonClicks: new Map<string, CapturedButtonClick[]>(),
  archiveState: {
    snapshots: [] as ReadonlyArray<unknown>,
    isLoading: false,
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
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: "#archive" }),
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

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    selector({ confirmThreadDelete: true }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: vi.fn(),
    unarchiveThread: vi.fn(),
  }),
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
  useArchivedThreadSnapshots: () => ({
    snapshots: testDoubles.archiveState.snapshots,
    error: null,
    isLoading: testDoubles.archiveState.isLoading,
    refresh: vi.fn(),
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
  testDoubles.buttonClicks.clear();
  testDoubles.archiveState.snapshots = [];
  testDoubles.archiveState.isLoading = false;
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
      });
    },
  );

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

  it("exposes the active archive sort direction in the button label", () => {
    const markup = renderPopulatedArchive("Archived");

    expect(markup).toContain('aria-label="Sort by Archived, descending"');
    expect(markup).toContain('aria-label="Sort by Created"');
    expect(markup).not.toContain("aria-sort");
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
});
