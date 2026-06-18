import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EnvironmentId,
  type EnvironmentApi,
  type ProjectEntry,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createElement, type ReactNode } from "react";

import { ComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  __readWorkspaceFilePanelStateForTests,
  __resetWorkspaceFilePanelStateForTests,
  closeWorkspaceFilePreview,
  openWorkspaceFileExplorer,
  openWorkspaceFilePreview,
  openWorkspaceSourceControlPanel,
} from "../workspaceFilePreview";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";

const {
  EditorMock,
  localConfirmMock,
  localContextMenuShowMock,
  refreshGitStatusMock,
  toastAddMock,
  useGitStatusMock,
} = vi.hoisted(() => ({
  EditorMock: class EditorMock {
    readonly cleanUp = vi.fn();
    constructor(
      readonly options: {
        onChange?: (file: { contents: string; name?: string; cacheKey?: string }) => void;
      } = {},
    ) {}
  },
  localConfirmMock: vi.fn(async () => true),
  localContextMenuShowMock: vi.fn(async () => "add-to-input" as string | null),
  refreshGitStatusMock: vi.fn<typeof import("../lib/gitStatusState").refreshGitStatus>(
    async () => null,
  ),
  toastAddMock: vi.fn(() => "toast-1"),
  useGitStatusMock: vi.fn<typeof import("../lib/gitStatusState").useGitStatus>(() => ({
    data: null,
    error: null,
    cause: null,
    isPending: false,
  })),
}));

vi.mock("../environments/runtime", () => ({
  addSavedEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://environment.test"),
  getPrimaryEnvironmentConnection: vi.fn(() => null),
  getSavedEnvironmentRecord: vi.fn(() => null),
  getSavedEnvironmentRuntimeState: vi.fn(() => null),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: vi.fn(() => []),
  readEnvironmentConnection: vi.fn(() => null),
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(() => {
    throw new Error("Environment connection not found.");
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: vi.fn(),
  startEnvironmentConnectionService: vi.fn(),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
  useSavedEnvironmentRegistryStore: vi.fn(() => ({})),
  useSavedEnvironmentRuntimeStore: vi.fn(() => ({})),
  waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
}));

vi.mock("../lib/gitStatusState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gitStatusState")>();
  return {
    ...actual,
    refreshGitStatus: refreshGitStatusMock,
    useGitStatus: useGitStatusMock,
  };
});

vi.mock("../localApi", () => ({
  readLocalApi: vi.fn(() => ({
    dialogs: {
      confirm: localConfirmMock,
    },
    contextMenu: {
      show: localContextMenuShowMock,
    },
  })),
}));

vi.mock("./ui/toast", () => ({
  toastManager: {
    add: toastAddMock,
  },
}));

vi.mock("@pierre/diffs/editor", () => ({
  Editor: EditorMock,
}));

vi.mock("./SourceControlPanel", async () => {
  const React = await import("react");
  return {
    default: () => React.createElement("div", null, "Source control panel"),
  };
});

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");

  return {
    EditorProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    FileDiff: (props: { fileDiff: { cacheKey?: string; name: string } }) =>
      React.createElement("div", {
        "data-cache-key": props.fileDiff.cacheKey,
        "data-file-name": props.fileDiff.name,
        "data-testid": "workspace-inline-file-diff",
      }),
    Virtualizer: ({
      children,
      className,
      contentClassName,
    }: {
      children: ReactNode;
      className?: string;
      contentClassName?: string;
    }) =>
      React.createElement(
        "div",
        {
          className,
          "data-testid": "workspace-file-virtualizer",
          style: { height: "100%", overflow: "auto" },
        },
        React.createElement("div", { className: contentClassName }, children),
      ),
    File: (props: { file: { contents: string } }) =>
      React.createElement("pre", { "data-testid": "workspace-file-render" }, props.file.contents),
    VirtualizerContext: React.createContext(undefined),
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-files-panel-browser");
const WORKSPACE_ROOT = "/repo/project";
const NON_REPOSITORY_STATUS: VcsStatusResult = {
  aheadCount: 0,
  behindCount: 0,
  hasPrimaryRemote: false,
  hasUpstream: false,
  hasWorkingTreeChanges: false,
  isDefaultRef: false,
  isRepo: false,
  pr: null,
  refName: null,
  workingTree: {
    deletions: 0,
    files: [],
    insertions: 0,
    staged: { files: [], insertions: 0, deletions: 0 },
    unstaged: { files: [], insertions: 0, deletions: 0 },
  },
};

function createMockEnvironmentApi(
  input: {
    rootEntries?: ProjectEntry[];
    searchEntries?: ProjectEntry[];
    srcEntries?: ProjectEntry[];
  } = {},
): EnvironmentApi {
  const srcEntries = input.srcEntries ?? [{ kind: "file", path: "src/App.tsx", parentPath: "src" }];
  const rootEntries = input.rootEntries ?? [
    { kind: "directory", path: "src" },
    { kind: "file", path: "README.md" },
  ];
  const searchEntries = input.searchEntries ?? [
    { kind: "file", path: "src/App.tsx", parentPath: "src" },
  ];
  return {
    projects: {
      listDirectoryEntries: vi.fn(async (input: { directoryPath?: string }) => ({
        entries: input.directoryPath === "src" ? srcEntries : rootEntries,
        truncated: false,
      })),
      readFile: vi.fn(async (input: { relativePath: string }) => ({
        relativePath: input.relativePath,
        contents: "export const component = true;\n",
        sizeBytes: 31,
        truncated: false,
      })),
      searchEntries: vi.fn(async () => ({
        entries: searchEntries,
        truncated: false,
      })),
      writeFile: vi.fn(),
      deleteEntry: vi.fn(async (input: { relativePath: string }) => ({
        relativePath: input.relativePath,
      })),
    },
  } as unknown as EnvironmentApi;
}

function createPreviewTarget(relativePath = "src/App.tsx") {
  return {
    environmentId: ENVIRONMENT_ID,
    cwd: WORKSPACE_ROOT,
    displayPath: relativePath,
    relativePath,
  };
}

function createComposerHandle(overrides: Partial<ChatComposerHandle> = {}): ChatComposerHandle {
  return {
    addPathMention: vi.fn(() => true),
    addTerminalContext: vi.fn(),
    focusAt: vi.fn(),
    focusAtEnd: vi.fn(),
    getSendContext: vi.fn(),
    isModelPickerOpen: vi.fn(() => false),
    openModelPicker: vi.fn(),
    readSnapshot: vi.fn(() => ({
      cursor: 0,
      expandedCursor: 0,
      terminalContextIds: [],
      value: "",
    })),
    resetCursorState: vi.fn(),
    toggleModelPicker: vi.fn(),
    ...overrides,
  } as unknown as ChatComposerHandle;
}

async function renderFilesPanel(
  input: {
    composerHandle?: ChatComposerHandle;
    initialize?: () => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const host = document.createElement("div");
  host.style.height = "320px";
  host.style.width = "720px";
  document.body.append(host);

  if (input.initialize) {
    input.initialize();
  } else {
    openWorkspaceFileExplorer({
      environmentId: ENVIRONMENT_ID,
      cwd: WORKSPACE_ROOT,
      projectName: "project",
    });
  }

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      input.composerHandle
        ? createElement(
            ComposerHandleContext.Provider,
            { value: { current: input.composerHandle } },
            createElement(WorkspaceFilesPanel, {
              mode: "sidebar",
              onReturnToDiff: vi.fn(),
              panelOpen: true,
            }),
          )
        : createElement(WorkspaceFilesPanel, {
            mode: "sidebar",
            onReturnToDiff: vi.fn(),
            panelOpen: true,
          }),
    ),
    { container: host },
  );

  return {
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("WorkspaceFilesPanel", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    __resetWorkspaceFilePanelStateForTests();
    vi.restoreAllMocks();
    refreshGitStatusMock.mockReset();
    refreshGitStatusMock.mockResolvedValue(null);
    localConfirmMock.mockReset();
    localConfirmMock.mockResolvedValue(true);
    localContextMenuShowMock.mockReset();
    localContextMenuShowMock.mockResolvedValue("add-to-input");
    toastAddMock.mockReset();
    toastAddMock.mockReturnValue("toast-1");
    useGitStatusMock.mockReset();
    useGitStatusMock.mockReturnValue({
      data: null,
      error: null,
      cause: null,
      isPending: false,
    });
    document.body.innerHTML = "";
  });

  it("renders file status badges and adds a file to the composer from the context menu", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    useGitStatusMock.mockReturnValue({
      data: {
        aheadCount: 0,
        behindCount: 0,
        hasPrimaryRemote: true,
        hasUpstream: false,
        hasWorkingTreeChanges: true,
        isDefaultRef: false,
        isRepo: true,
        pr: null,
        refName: "feature/files-panel",
        workingTree: {
          deletions: 1,
          files: [
            { path: "src/App.tsx", status: "modified", insertions: 5, deletions: 1 },
            { path: "README.md", status: "untracked", insertions: 0, deletions: 0 },
          ],
          insertions: 5,
          staged: { files: [], insertions: 0, deletions: 0 },
          unstaged: {
            deletions: 1,
            files: [
              { path: "src/App.tsx", status: "modified", insertions: 5, deletions: 1 },
              { path: "README.md", status: "untracked", insertions: 0, deletions: 0 },
            ],
            insertions: 5,
          },
        },
      },
      error: null,
      cause: null,
      isPending: false,
    });
    const addPathMention = vi.fn(() => true);
    const mounted = await renderFilesPanel({
      composerHandle: createComposerHandle({ addPathMention }),
    });
    try {
      await expect.element(page.getByText("Modified")).not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: /^src$/ })).toBeVisible();
      const explorerList = document.querySelector(".overflow-auto.py-1");
      expect(explorerList?.className).toContain("select-none");
      expect(explorerList?.className).toContain("[touch-action:pan-y]");
      expect(explorerList?.className).toContain("[-webkit-touch-callout:none]");
      await vi.waitFor(() => {
        expect(
          document.querySelector(
            '[aria-label="src contains 1 changed file; highest status modified"]',
          )?.textContent,
        ).toBe("M");
        expect(document.querySelector('[aria-label="README.md is untracked"]')?.textContent).toBe(
          "U",
        );
        expect(document.querySelector('button[title="src"] span.truncate')?.className).toContain(
          "text-warning-foreground",
        );
        expect(
          document.querySelector('button[title="README.md"] span.truncate')?.className,
        ).toContain("text-success");
      });
      const srcDirectoryButton = document.querySelector<HTMLButtonElement>('button[title="src"]');
      expect(srcDirectoryButton?.className).toContain("select-none");
      const readmeButton = document.querySelector<HTMLButtonElement>('button[title="README.md"]');
      const readmeRow = readmeButton?.parentElement;
      expect(Math.round(readmeRow?.getBoundingClientRect().height ?? 0)).toBe(32);
      expect(getComputedStyle(readmeButton!).fontSize).toBe("16px");
      expect(readmeButton?.querySelector("svg,img")?.getAttribute("class")).toContain("size-5");
      srcDirectoryButton?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 8,
          clientY: 16,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(localContextMenuShowMock).not.toHaveBeenCalled();
      expect(addPathMention).not.toHaveBeenCalled();

      await page.getByRole("button", { name: /^src$/ }).click();
      await expect.element(page.getByRole("button", { name: /^App\.tsx$/ })).toBeVisible();
      expect(document.querySelector('[aria-label="src/App.tsx is modified"]')?.textContent).toBe(
        "M",
      );
      expect(
        document.querySelector('button[title="src/App.tsx"] span.truncate')?.className,
      ).toContain("text-warning-foreground");
      await expect
        .element(page.getByRole("button", { name: "Add src/App.tsx to chat input" }))
        .not.toBeInTheDocument();

      document.querySelector<HTMLButtonElement>('button[title="src/App.tsx"]')?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 24,
        }),
      );

      await vi.waitFor(() => {
        expect(localContextMenuShowMock).toHaveBeenCalledWith(
          [
            { id: "add-to-input", label: "Add to chat input" },
            { id: "delete-entry", label: "Delete file", destructive: true },
          ],
          { x: 12, y: 24 },
        );
        expect(addPathMention).toHaveBeenCalledWith("src/App.tsx");
        expect(toastAddMock).toHaveBeenCalledWith({
          type: "success",
          title: "Added to input",
          description: "@src/App.tsx",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("confirms before deleting explorer files from the context menu", async () => {
    const api = createMockEnvironmentApi();
    const invalidateQueriesSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    localContextMenuShowMock.mockResolvedValue("delete-entry");
    const mounted = await renderFilesPanel();
    try {
      await expect.element(page.getByRole("button", { name: /^README\.md$/ })).toBeVisible();
      refreshGitStatusMock.mockClear();
      invalidateQueriesSpy.mockClear();
      toastAddMock.mockClear();

      document.querySelector<HTMLButtonElement>('button[title="README.md"]')?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 28,
        }),
      );

      await vi.waitFor(() => {
        expect(localContextMenuShowMock).toHaveBeenCalledWith(
          [
            { id: "add-to-input", label: "Add to chat input" },
            { id: "delete-entry", label: "Delete file", destructive: true },
          ],
          { x: 20, y: 28 },
        );
        expect(localConfirmMock).toHaveBeenCalledWith(
          'Delete file "README.md"?\n\nThis cannot be undone.',
        );
        expect(api.projects.deleteEntry).toHaveBeenCalledWith({
          cwd: WORKSPACE_ROOT,
          relativePath: "README.md",
        });
        expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: projectQueryKeys.all });
        expect(refreshGitStatusMock).toHaveBeenCalledWith(
          { environmentId: ENVIRONMENT_ID, cwd: WORKSPACE_ROOT },
          { force: true },
        );
        expect(toastAddMock).toHaveBeenCalledWith({
          type: "success",
          title: "Deleted file",
          description: "README.md",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not delete explorer files when confirmation is cancelled", async () => {
    const api = createMockEnvironmentApi();
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    localContextMenuShowMock.mockResolvedValue("delete-entry");
    localConfirmMock.mockResolvedValue(false);
    const mounted = await renderFilesPanel();
    try {
      await expect.element(page.getByRole("button", { name: /^README\.md$/ })).toBeVisible();

      document.querySelector<HTMLButtonElement>('button[title="README.md"]')?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 28,
        }),
      );

      await vi.waitFor(() => {
        expect(localConfirmMock).toHaveBeenCalledWith(
          'Delete file "README.md"?\n\nThis cannot be undone.',
        );
      });
      expect(api.projects.deleteEntry).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("confirms before deleting empty folders from the context menu", async () => {
    const api = createMockEnvironmentApi({
      rootEntries: [{ kind: "directory", path: "src" }],
      srcEntries: [],
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    localContextMenuShowMock.mockResolvedValue("delete-entry");
    const mounted = await renderFilesPanel({
      initialize: () =>
        openWorkspaceFileExplorer({
          environmentId: ENVIRONMENT_ID,
          cwd: WORKSPACE_ROOT,
          projectName: "project",
        }),
    });
    try {
      await expect.element(page.getByRole("button", { name: /^src$/ })).toBeVisible();
      refreshGitStatusMock.mockClear();
      toastAddMock.mockClear();

      document.querySelector<HTMLButtonElement>('button[title="src"]')?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 16,
          clientY: 22,
        }),
      );

      await vi.waitFor(() => {
        expect(localContextMenuShowMock).toHaveBeenCalledWith(
          [{ id: "delete-entry", label: "Delete empty folder", destructive: true }],
          { x: 16, y: 22 },
        );
        expect(localConfirmMock).toHaveBeenCalledWith(
          'Delete empty folder "src"?\n\nThis cannot be undone.',
        );
        expect(api.projects.deleteEntry).toHaveBeenCalledWith({
          cwd: WORKSPACE_ROOT,
          relativePath: "src",
        });
        expect(refreshGitStatusMock).toHaveBeenCalledWith(
          { environmentId: ENVIRONMENT_ID, cwd: WORKSPACE_ROOT },
          { force: true },
        );
        expect(toastAddMock).toHaveBeenCalledWith({
          type: "success",
          title: "Deleted folder",
          description: "src",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders explorer entries when git status reports a non-repository", async () => {
    const api = createMockEnvironmentApi();
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    useGitStatusMock.mockReturnValue({
      data: NON_REPOSITORY_STATUS,
      error: null,
      cause: null,
      isPending: false,
    });
    const mounted = await renderFilesPanel();
    try {
      await expect.element(page.getByRole("button", { name: /^src$/ })).toBeVisible();
      await expect.element(page.getByRole("button", { name: /^README\.md$/ })).toBeVisible();
      await vi.waitFor(() => {
        expect(api.projects.listDirectoryEntries).toHaveBeenCalledWith({
          cwd: WORKSPACE_ROOT,
          limit: 500,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders gitignored-looking explorer entries normally when they are not marked ignored", async () => {
    __setEnvironmentApiOverrideForTests(
      ENVIRONMENT_ID,
      createMockEnvironmentApi({
        rootEntries: [
          { kind: "directory", path: "src" },
          { kind: "file", path: "README.md" },
          { kind: "file", path: "websocket-diagnostics1.md" },
        ],
      }),
    );
    const mounted = await renderFilesPanel();
    try {
      await expect
        .element(page.getByRole("button", { name: /^websocket-diagnostics1\.md$/ }))
        .toBeVisible();
      expect(
        document.querySelector('button[title="websocket-diagnostics1.md"] span.truncate')
          ?.className,
      ).toContain("text-foreground/88");
      expect(
        document.querySelector('button[title="README.md"] span.truncate')?.className,
      ).toContain("text-foreground/88");
    } finally {
      await mounted.cleanup();
    }
  });

  it("refreshes git status and invalidates file queries when the explorer opens", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    const invalidateQueriesSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const mounted = await renderFilesPanel();
    try {
      await vi.waitFor(() => {
        expect(refreshGitStatusMock).toHaveBeenCalledWith({
          environmentId: ENVIRONMENT_ID,
          cwd: WORKSPACE_ROOT,
        });
        expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: projectQueryKeys.all });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("previews explorer file clicks in the same panel and returns to preserved explorer state", async () => {
    const api = createMockEnvironmentApi();
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    const mounted = await renderFilesPanel();
    try {
      await page.getByRole("button", { name: /^src$/ }).click();
      await vi.waitFor(() => {
        expect(api.projects.listDirectoryEntries).toHaveBeenCalledWith({
          cwd: WORKSPACE_ROOT,
          directoryPath: "src",
          limit: 500,
        });
      });

      await page.getByPlaceholder("Search files").fill("App");
      await page.getByRole("button", { name: /^src\/App\.tsx$/ }).click();

      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Back to explorer" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Show file explorer" }))
        .not.toBeInTheDocument();

      await page.getByRole("button", { name: "Back to explorer" }).click();
      await expect
        .element(page.getByRole("button", { name: "Back to file viewer" }))
        .not.toBeInTheDocument();
      const searchInput = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search files"]',
      );
      expect(searchInput?.value).toBe("App");

      await page.getByPlaceholder("Search files").fill("");
      await expect.element(page.getByRole("button", { name: /^src$/ })).toBeVisible();
      await expect.element(page.getByRole("button", { name: /^App\.tsx$/ })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("returns source control file previews to the source control panel", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    const mounted = await renderFilesPanel({
      initialize: () =>
        openWorkspaceFilePreview(
          {
            environmentId: ENVIRONMENT_ID,
            cwd: WORKSPACE_ROOT,
            relativePath: "src/App.tsx",
            displayPath: "src/App.tsx",
          },
          { returnTarget: { kind: "source-control" } },
        ),
    });
    try {
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();
      await page.getByRole("button", { name: "Back to source control" }).click();

      await expect.element(page.getByText("Source control panel")).toBeVisible();
      expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
        open: true,
        view: "source-control",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("returns from explorer to source control through the stacked file preview", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    const mounted = await renderFilesPanel({
      initialize: () => {
        openWorkspaceSourceControlPanel();
        openWorkspaceFilePreview(createPreviewTarget("README.md"));
      },
    });
    try {
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Back to source control" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Show file explorer" }).click();
      await expect.element(page.getByRole("button", { name: "Back to file viewer" })).toBeVisible();

      await page.getByRole("button", { name: "Back to file viewer" }).click();
      await expect
        .element(page.getByRole("button", { name: "Back to source control" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Back to source control" }).click();
      await expect.element(page.getByText("Source control panel")).toBeVisible();
      expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
        open: true,
        view: "source-control",
        history: [],
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps explorer file previews in the right sidebar stack", async () => {
    const api = createMockEnvironmentApi();
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    const mounted = await renderFilesPanel({
      initialize: () => {
        openWorkspaceSourceControlPanel();
        openWorkspaceFilePreview(createPreviewTarget("README.md"));
      },
    });
    try {
      await expect
        .element(page.getByRole("button", { name: "Back to source control" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Show file explorer" }).click();
      await page.getByRole("button", { name: /^src$/ }).click();
      await vi.waitFor(() => {
        expect(api.projects.listDirectoryEntries).toHaveBeenCalledWith({
          cwd: WORKSPACE_ROOT,
          directoryPath: "src",
          limit: 500,
        });
      });
      await page.getByRole("button", { name: /^App\.tsx$/ }).click();

      await expect.element(page.getByRole("button", { name: "Back to explorer" })).toBeVisible();
      await page.getByRole("button", { name: "Back to explorer" }).click();

      await expect.element(page.getByRole("button", { name: "Back to file viewer" })).toBeVisible();
      await page.getByRole("button", { name: "Back to file viewer" }).click();

      await expect
        .element(page.getByRole("button", { name: "Back to source control" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Back to source control" }).click();

      await expect.element(page.getByText("Source control panel")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves tree scroll position when returning from preview", async () => {
    const rootEntries = [
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: "file" as const,
        path: `docs/file-${String(index).padStart(2, "0")}.ts`,
      })),
      { kind: "file" as const, path: "src/App.tsx" },
    ] satisfies ProjectEntry[];
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi({ rootEntries }));
    const mounted = await renderFilesPanel();
    try {
      await expect.element(page.getByRole("button", { name: /^file-08\.ts$/ })).toBeVisible();
      const explorerScroll = document.querySelector<HTMLElement>(
        '[data-testid="workspace-file-explorer-scroll"]',
      );
      expect(explorerScroll).not.toBeNull();
      explorerScroll!.scrollTop = 180;
      explorerScroll!.dispatchEvent(new Event("scroll", { bubbles: true }));

      document.querySelector<HTMLButtonElement>('button[title="docs/file-08.ts"]')?.click();
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();

      await page.getByRole("button", { name: "Back to explorer" }).click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-testid="workspace-file-explorer-scroll"]')
            ?.scrollTop,
        ).toBe(180);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps tree and search scroll positions separate", async () => {
    const rootEntries = Array.from({ length: 32 }, (_, index) => ({
      kind: "file" as const,
      path: `docs/file-${String(index).padStart(2, "0")}.ts`,
    })) satisfies ProjectEntry[];
    const searchEntries = Array.from({ length: 32 }, (_, index) => ({
      kind: "file" as const,
      path: `src/App-${String(index).padStart(2, "0")}.tsx`,
      parentPath: "src",
    })) satisfies ProjectEntry[];
    __setEnvironmentApiOverrideForTests(
      ENVIRONMENT_ID,
      createMockEnvironmentApi({ rootEntries, searchEntries }),
    );
    const mounted = await renderFilesPanel();
    try {
      await expect.element(page.getByRole("button", { name: /^file-08\.ts$/ })).toBeVisible();
      const treeScroll = document.querySelector<HTMLElement>(
        '[data-testid="workspace-file-explorer-scroll"]',
      );
      expect(treeScroll).not.toBeNull();
      treeScroll!.scrollTop = 160;
      treeScroll!.dispatchEvent(new Event("scroll", { bubbles: true }));

      await page.getByPlaceholder("Search files").fill("App");
      await expect.element(page.getByRole("button", { name: /^src\/App-08\.tsx$/ })).toBeVisible();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-testid="workspace-file-explorer-scroll"]')
            ?.scrollTop,
        ).toBe(0);
      });
      const searchScroll = document.querySelector<HTMLElement>(
        '[data-testid="workspace-file-explorer-scroll"]',
      );
      expect(searchScroll).not.toBeNull();
      searchScroll!.scrollTop = 80;
      searchScroll!.dispatchEvent(new Event("scroll", { bubbles: true }));

      document.querySelector<HTMLButtonElement>('button[title="src/App-08.tsx"]')?.click();
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();

      await page.getByRole("button", { name: "Back to explorer" }).click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-testid="workspace-file-explorer-scroll"]')
            ?.scrollTop,
        ).toBe(80);
      });

      await page.getByPlaceholder("Search files").fill("");
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>('[data-testid="workspace-file-explorer-scroll"]')
            ?.scrollTop,
        ).toBe(160);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses a one-step file viewer breadcrumb only when explorer is opened from preview", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    const mounted = await renderFilesPanel({
      initialize: () => openWorkspaceFilePreview(createPreviewTarget()),
    });
    try {
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();

      await page.getByRole("button", { name: "Show file explorer" }).click();
      await expect.element(page.getByRole("button", { name: "Back to file viewer" })).toBeVisible();

      await page.getByRole("button", { name: "Back to file viewer" }).click();
      await expect.element(page.getByText("export const component = true;")).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Back to file viewer" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show stale file viewer back navigation when explorer opens directly", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi());
    const mounted = await renderFilesPanel({
      initialize: () => {
        openWorkspaceFilePreview(createPreviewTarget("README.md"));
        closeWorkspaceFilePreview();
        openWorkspaceFileExplorer({
          environmentId: ENVIRONMENT_ID,
          cwd: WORKSPACE_ROOT,
          projectName: "project",
        });
      },
    });
    try {
      await expect.element(page.getByPlaceholder("Search files")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Back to file viewer" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
