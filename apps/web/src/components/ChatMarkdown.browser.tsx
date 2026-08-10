import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const {
  createAssetUrlMock,
  openFileInPreviewMock,
  openBrowserMock,
  openInPreferredEditorMock,
  openPreviewMock,
  navigateMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
  openFileInPreviewMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openBrowserMock: vi.fn(),
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  openPreviewMock: vi.fn(),
  navigateMock: vi.fn(async () => undefined),
  readLocalApiMock: vi.fn(() => ({
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: { openInEditor: vi.fn(async () => undefined) },
  })),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({
    assets: { createUrl: createAssetUrlMock },
  })),
}));

vi.mock("../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
  resolveEnvironmentHttpUrl: vi.fn((_environmentId: string, path: string) => path),
}));

vi.mock("../previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  isPreviewSupportedInRuntime: vi.fn(() => true),
  rememberPreviewUrl: vi.fn(),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => openPreviewMock),
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openBrowser: openBrowserMock }),
  },
}));

vi.mock("../browser/openFileInPreview", () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: openFileInPreviewMock,
}));

import ChatMarkdown from "./ChatMarkdown";
import { selectEnvironmentState, useStore } from "../store";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-markdown"),
  ThreadId.make("thread-markdown"),
);
const initialStoreState = useStore.getState();

function addThreadSummary(threadId: ThreadId, title: string) {
  const state = useStore.getState();
  const environmentState = selectEnvironmentState(state, threadRef.environmentId);
  useStore.setState({
    environmentStateById: {
      ...state.environmentStateById,
      [threadRef.environmentId]: {
        ...environmentState,
        sidebarThreadSummaryById: {
          ...environmentState.sidebarThreadSummaryById,
          [threadId]: {
            id: threadId,
            environmentId: threadRef.environmentId,
            projectId: ProjectId.make("project-markdown"),
            parentThreadId: null,
            title,
            interactionMode: "default",
            session: null,
            createdAt: "2026-07-31T00:00:00.000Z",
            archivedAt: null,
            latestTurn: null,
            branch: null,
            worktreePath: null,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        },
      },
    },
  });
}

describe("ChatMarkdown", () => {
  afterEach(() => {
    useStore.setState(initialStoreState, true);
    openInPreferredEditorMock.mockClear();
    openFileInPreviewMock.mockClear();
    openPreviewMock.mockClear();
    navigateMock.mockClear();
    createAssetUrlMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("navigates thread references within the current environment", async () => {
    const linkedThreadId = "bc880b45-fd48-42db-98fa-f211bae7cc0a";
    const uppercaseThreadId = linkedThreadId.toUpperCase();
    addThreadSummary(ThreadId.make(linkedThreadId), "Finish PR review fixes");
    const screen = await render(
      <ChatMarkdown
        text={`Created replacement thread: \`${uppercaseThreadId}\``}
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "Open thread Finish PR review fixes" });
      await expect.element(link).toHaveTextContent("Finish PR review fixes");
      await expect.element(link).not.toHaveTextContent(linkedThreadId);
      await link.click();
      await vi.waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: threadRef.environmentId,
            threadId: linkedThreadId,
          },
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens normal web links in the integrated browser", async () => {
    openPreviewMock.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        threadId: threadRef.threadId,
        tabId: "tab-web-link",
        navStatus: {
          _tag: "Loading",
          url: "https://openai.com/docs",
          title: "",
        },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    });
    const screen = await render(
      <ChatMarkdown
        text="[OpenAI](https://openai.com/docs)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
      await link.click();
      await vi.waitFor(() => {
        expect(openPreviewMock).toHaveBeenCalledWith({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            url: "https://openai.com/docs",
          },
        });
        expect(openBrowserMock).toHaveBeenCalledWith(threadRef, "tab-web-link");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps table headers from inheriting emergency word breaks", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "| Rank | Finding | Impact / effort |",
          "| --- | --- | --- |",
          "| 1 | Every event fans out to every projection. | Very high / medium |",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await vi.waitFor(() => {
        const header = [...document.querySelectorAll("th")].find(
          (candidate) => candidate.textContent?.trim() === "Rank",
        );
        expect(header).toBeInstanceOf(HTMLTableCellElement);
        expect(getComputedStyle(header!).overflowWrap).not.toBe("anywhere");
      });
    } finally {
      await screen.unmount();
    }
  });

  it.each(["report.html", "report.pdf"])(
    "opens linked %s files in the integrated browser",
    async (fileName) => {
      const screen = await render(
        <ChatMarkdown
          text={`[${fileName}](./${fileName})`}
          cwd="/repo/project"
          threadRef={threadRef}
        />,
      );

      try {
        await page.getByRole("link", { name: fileName }).click();
        await vi.waitFor(() => {
          expect(openFileInPreviewMock).toHaveBeenCalledWith({
            threadRef,
            relativePath: `/repo/project/./${fileName}`,
            httpBaseUrl: "http://localhost:3773",
            createAssetUrl: createAssetUrlMock,
            openPreview: openPreviewMock,
          });
        });
        expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("strips source positions from integrated browser preview paths", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[report.html](./report.html#L12)"
        cwd="/repo/project"
        threadRef={threadRef}
      />,
    );

    try {
      await page.getByRole("link", { name: "report.html · L12" }).click();
      await vi.waitFor(() => {
        expect(openFileInPreviewMock).toHaveBeenCalledWith({
          threadRef,
          relativePath: "/repo/project/./report.html",
          httpBaseUrl: "http://localhost:3773",
          createAssetUrl: createAssetUrlMock,
          openPreview: openPreviewMock,
        });
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
