import "../index.css";

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const ENVIRONMENT_ID = "environment-diff-browser";
const THREAD_ID = "thread-diff-browser";

const {
  fileDiffRenderCalls,
  navigateSpy,
  openWorkspaceFilePreviewSpy,
  parsedFilesRef,
  sourceControlOpenRef,
  virtualizerRenderCalls,
  workingTreeDiffRef,
} = vi.hoisted(() => ({
  fileDiffRenderCalls: [] as Array<{
    fileDiff: { name: string };
    options: { collapsed?: boolean } | undefined;
  }>,
  navigateSpy: vi.fn(),
  openWorkspaceFilePreviewSpy: vi.fn(),
  parsedFilesRef: {
    current: [] as Array<{
      cacheKey?: string;
      hunks: Array<{ unifiedLineCount: number }>;
      name: string;
      type: "change" | "deleted" | "new" | "rename-changed" | "rename-pure";
      unifiedLineCount: number;
    }>,
  },
  sourceControlOpenRef: { current: false },
  virtualizerRenderCalls: [] as Array<{
    className: string | undefined;
    config:
      | {
          intersectionObserverMargin?: number;
          overscrollSize?: number;
        }
      | undefined;
  }>,
  workingTreeDiffRef: { current: "diff --git a/src/App.tsx b/src/App.tsx" },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useParams: vi.fn((input?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
    return input?.select ? input.select(params) : params;
  }),
  useSearch: vi.fn((input?: { select?: (search: Record<string, unknown>) => unknown }) => {
    const search = { diff: "1", diffSource: "unstaged" };
    return input?.select ? input.select(search) : search;
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { __kind?: string }) => {
    if (options.__kind === "working-tree-diff") {
      return {
        data: { diff: workingTreeDiffRef.current },
        error: null,
        isFetched: true,
        isLoading: false,
        refetch: vi.fn(),
      };
    }
    return {
      data: null,
      error: null,
      isFetched: true,
      isLoading: false,
      refetch: vi.fn(),
    };
  }),
}));

vi.mock("@pierre/diffs", async () => {
  const actual = await vi.importActual<typeof import("@pierre/diffs")>("@pierre/diffs");
  return {
    ...actual,
    parsePatchFiles: vi.fn(() => [{ files: parsedFilesRef.current }]),
  };
});

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    FileDiff: (props: {
      fileDiff: { name: string };
      options?: { collapsed?: boolean };
      renderHeaderMetadata?: () => ReactNode;
      renderHeaderPrefix?: () => ReactNode;
    }) => {
      fileDiffRenderCalls.push({
        fileDiff: props.fileDiff,
        options: props.options,
      });
      return React.createElement(
        "div",
        {
          "data-collapsed": props.options?.collapsed ? "true" : "false",
          "data-file-name": props.fileDiff.name,
          "data-testid": "diff-file-render",
        },
        props.renderHeaderPrefix?.(),
        props.renderHeaderMetadata?.(),
      );
    },
    Virtualizer: ({
      children,
      className,
      config,
    }: {
      children: ReactNode;
      className?: string;
      config?: { intersectionObserverMargin?: number; overscrollSize?: number };
    }) => {
      virtualizerRenderCalls.push({ className, config });
      return React.createElement(
        "div",
        {
          className,
          "data-testid": "diff-virtualizer",
        },
        children,
      );
    },
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useWorkerPool: () => ({
      getDiffRenderOptions: () => ({ theme: "pierre-dark" }),
      setRenderOptions: vi.fn(async () => undefined),
    }),
  };
});

vi.mock("~/lib/gitReactQuery", () => ({
  gitWorkingTreeDiffQueryOptions: vi.fn(() => ({ __kind: "working-tree-diff" })),
}));

vi.mock("~/lib/providerReactQuery", () => ({
  checkpointDiffQueryOptions: vi.fn(() => ({ __kind: "checkpoint-diff" })),
}));

vi.mock("~/lib/gitStatusState", () => ({
  useGitStatus: vi.fn(() => ({
    data: { isRepo: true },
    error: null,
    isPending: false,
  })),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: vi.fn(() => ({
    diffIgnoreWhitespace: false,
    diffWordWrap: false,
  })),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: vi.fn(() => ({ resolvedTheme: "dark" })),
}));

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: vi.fn(() => ({
    inferredCheckpointTurnCountByTurnId: {},
    turnDiffSummaries: [],
  })),
}));

vi.mock("../composerDraftStore", () => ({
  DraftId: {
    make: (value: string) => value,
  },
  useComposerDraftStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      getDraftSession: () => null,
      getDraftSessionByRef: () => null,
    }),
  ),
}));

vi.mock("../storeSelectors", () => ({
  createThreadSelectorByRef: vi.fn(() => () => ({
    environmentId: ENVIRONMENT_ID,
    id: THREAD_ID,
    projectId: "project-diff-browser",
    turnDiffSummaries: [],
    worktreePath: "/repo/project",
  })),
}));

vi.mock("../store", () => ({
  selectProjectByRef: vi.fn(() => ({ cwd: "/repo/project" })),
  useStore: vi.fn((selector: (state: unknown) => unknown) => selector({})),
}));

vi.mock("../rightPanelGesture", () => ({
  openRightPanel: vi.fn(),
}));

vi.mock("../workspaceFilePreview", () => ({
  openPathInPreferredEditorOrFilePreview: vi.fn(async () => undefined),
  openWorkspaceFilePreview: openWorkspaceFilePreviewSpy,
}));

vi.mock("../sourceControlPanelState", () => ({
  useSourceControlPanelState: vi.fn(() => ({
    commitMessage: "",
    open: sourceControlOpenRef.current,
  })),
}));

vi.mock("../workspaceImagePreview", () => ({
  isWorkspaceImagePreviewPath: vi.fn(() => false),
  resolveWorkspaceGitImagePreviewUrl: vi.fn(() => null),
  resolveWorkspaceImagePreviewUrl: vi.fn(() => null),
}));

import DiffPanel from "./DiffPanel";

function fileDiff(name: string, unifiedLineCount = 4) {
  return {
    cacheKey: `cache:${name}`,
    hunks: [{ unifiedLineCount }],
    name,
    type: "change" as const,
    unifiedLineCount,
  };
}

describe("DiffPanel", () => {
  afterEach(() => {
    fileDiffRenderCalls.length = 0;
    virtualizerRenderCalls.length = 0;
    openWorkspaceFilePreviewSpy.mockClear();
    parsedFilesRef.current = [];
    sourceControlOpenRef.current = false;
    workingTreeDiffRef.current = "diff --git a/src/App.tsx b/src/App.tsx";
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("wraps file diffs in the diff virtualizer with bounded overscan", async () => {
    parsedFilesRef.current = [fileDiff("src/App.tsx"), fileDiff("src/utils.ts")];
    const screen = await render(<DiffPanel mode="sidebar" />);

    try {
      await vi.waitFor(() => {
        expect(virtualizerRenderCalls.length).toBeGreaterThan(0);
      });
      expect(virtualizerRenderCalls.at(-1)).toMatchObject({
        className: "diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2",
        config: {
          intersectionObserverMargin: 1200,
          overscrollSize: 600,
        },
      });
      expect(fileDiffRenderCalls.map((call) => call.fileDiff.name)).toEqual([
        "src/App.tsx",
        "src/utils.ts",
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("preserves file collapse behavior through FileDiff options", async () => {
    parsedFilesRef.current = [fileDiff("src/App.tsx")];
    const screen = await render(<DiffPanel mode="sidebar" />);

    try {
      await vi.waitFor(() => {
        expect(fileDiffRenderCalls.at(-1)?.options?.collapsed).toBe(false);
      });
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Collapse src/App.tsx"]')
        ?.click();
      await vi.waitFor(() => {
        expect(fileDiffRenderCalls.at(-1)?.options?.collapsed).toBe(true);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens a diff file in the workspace preview from the file header", async () => {
    parsedFilesRef.current = [fileDiff("src/App.tsx")];
    const screen = await render(<DiffPanel mode="sidebar" />);

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Preview src/App.tsx"]')).not.toBeNull();
      });

      document
        .querySelector<HTMLButtonElement>('button[aria-label="Preview src/App.tsx"]')
        ?.click();

      expect(openWorkspaceFilePreviewSpy).toHaveBeenCalledWith(
        {
          environmentId: ENVIRONMENT_ID,
          cwd: "/repo/project",
          relativePath: "src/App.tsx",
          displayPath: "src/App.tsx",
        },
        {
          returnTarget: {
            kind: "diff",
            diffSource: "unstaged",
            diffFilePath: "src/App.tsx",
          },
        },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("returns to source control from the diff header when source control is hidden behind diff", async () => {
    sourceControlOpenRef.current = true;
    parsedFilesRef.current = [fileDiff("src/App.tsx")];
    const screen = await render(<DiffPanel mode="sidebar" />);

    try {
      await vi.waitFor(() => {
        expect(
          document.querySelector('button[aria-label="Back to source control"]'),
        ).not.toBeNull();
      });

      document
        .querySelector<HTMLButtonElement>('button[aria-label="Back to source control"]')
        ?.click();

      const navigateInput = navigateSpy.mock.calls.at(-1)?.[0] as
        | {
            search: (previous: Record<string, unknown>) => Record<string, unknown>;
            to: string;
          }
        | undefined;
      expect(navigateInput).toMatchObject({ to: "/$environmentId/$threadId" });
      expect(
        navigateInput?.search({
          diff: "1",
          diffSource: "unstaged",
          diffFilePath: "src/App.tsx",
          panel: "activity",
        }),
      ).toEqual({
        diff: undefined,
        diffSource: undefined,
        diffTurnId: undefined,
        diffFilePath: undefined,
        panel: "activity",
      });
    } finally {
      await screen.unmount();
    }
  });
});
