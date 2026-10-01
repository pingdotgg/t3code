import "../../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  openFileInPreviewMock,
  openPreviewMock,
  listEntriesMock,
  readFileMock,
  writeFileMock,
  createAssetUrlMock,
} = vi.hoisted(() => ({
  openFileInPreviewMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openPreviewMock: vi.fn(),
  listEntriesMock: vi.fn(async () => ({
    entries: [
      { path: "src", kind: "directory" as const },
      { path: "src/index.ts", kind: "file" as const, parentPath: "src" },
    ],
    truncated: false,
  })),
  readFileMock: vi.fn(
    async (): Promise<{ relativePath: string; contents: string; binary?: boolean }> => ({
      relativePath: "src/index.ts",
      contents: "export const covered = true;",
    }),
  ),
  writeFileMock: vi.fn(async () => ({ relativePath: "src/index.ts" })),
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(() => ({
    projects: { listEntries: listEntriesMock, readFile: readFileMock, writeFile: writeFileMock },
    assets: { createUrl: createAssetUrlMock },
  })),
  readEnvironmentApi: vi.fn(() => ({
    projects: { listEntries: listEntriesMock, readFile: readFileMock, writeFile: writeFileMock },
    assets: { createUrl: createAssetUrlMock },
  })),
}));

vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
  getSavedEnvironmentRecord: vi.fn(() => null),
  getSavedEnvironmentRuntimeState: vi.fn(() => null),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: vi.fn(() => []),
  readSavedEnvironmentBearerToken: vi.fn(() => null),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: vi.fn((_environmentId: unknown, path: string) => path),
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (selector: (state: object) => unknown) => selector({}),
  waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
  addSavedEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  getPrimaryEnvironmentConnection: vi.fn(() => null),
  readEnvironmentConnection: vi.fn(() => null),
  reconnectSavedEnvironment: vi.fn(),
  setSavedEnvironmentEnabled: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(() => {
    throw new Error("environment unavailable");
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  startEnvironmentConnectionService: vi.fn(),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
}));

vi.mock("~/environments/runtime/catalog", () => ({
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
}));

vi.mock("~/environments/primary", () => ({
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
  applyPreviewServerSnapshot: vi.fn(),
  applyPreviewServerEvent: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
  reconcilePreviewServerSessions: vi.fn(),
  applyPreviewDesktopState: vi.fn(),
  beginPreviewSessionClose: vi.fn(),
  cancelPreviewSessionClose: vi.fn(),
  setActivePreviewTab: vi.fn(),
  rememberPreviewUrl: vi.fn(),
  removePreviewThread: vi.fn(),
  resetPreviewStateForTests: vi.fn(),
  useThreadPreviewState: () => null,
  useActivePreviewSessions: () => ({}),
  readThreadPreviewState: vi.fn(() => null),
  subscribeThreadPreviewState: vi.fn(() => () => undefined),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => openPreviewMock),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: openFileInPreviewMock,
}));

import { FilePreviewPanel } from "./FilePreviewPanel";
import { getProjectFileSaveSession } from "./projectFileSaveSession";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

describe("FilePreviewPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a detached save failure after reopening and retries without reindexing", async () => {
    const cwd = "/repo/reopen-failed-save";
    const relativePath = "src/index.ts";
    const session = getProjectFileSaveSession(threadRef.environmentId, cwd, relativePath);
    let fail!: (cause: Error) => void;
    writeFileMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const props = { cwd, relativePath, threadRef, onOpenFile: vi.fn() };
    const first = await render(<FilePreviewPanel {...props} />);
    await expect.element(page.getByText("export const covered = true;")).toBeInTheDocument();
    session.change("export const retained = true;");
    await first.unmount();
    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(1));
    fail(new Error("permission denied"));
    await vi.waitFor(() => expect(session.getSnapshot().error).toBe("permission denied"));

    const reopened = await render(<FilePreviewPanel {...props} />);
    try {
      await expect.element(page.getByText("Save failed: permission denied")).toBeInTheDocument();
      await expect.element(page.getByText("export const retained = true;")).toBeInTheDocument();
      const indexReads = listEntriesMock.mock.calls.length;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(2));
      await expect
        .element(page.getByText("Save failed: permission denied"))
        .not.toBeInTheDocument();
      expect(listEntriesMock).toHaveBeenCalledTimes(indexReads);
    } finally {
      await reopened.unmount();
    }
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });

  it("constrains long file scrolling to the retained panel height", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "long.ts",
      contents: Array.from({ length: 500 }, (_, index) => `const line${index} = ${index};`).join(
        "\n",
      ),
    });
    const screen = await render(
      <div style={{ height: 400, width: 700, overflow: "hidden" }}>
        <div className="h-full min-h-0">
          <FilePreviewPanel
            cwd="/repo/long-file"
            relativePath="long.ts"
            threadRef={threadRef}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      await vi.waitFor(() => {
        const viewport = document.querySelector(".file-preview-virtualizer");
        expect(viewport).not.toBeNull();
        expect(viewport!.clientHeight).toBeGreaterThan(0);
        expect(viewport!.clientHeight).toBeLessThan(400);
        expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("scrolls to the chat-linked line on open", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "long-reveal.ts",
      contents: Array.from({ length: 500 }, (_, index) => `const line${index} = ${index};`).join(
        "\n",
      ),
    });
    const screen = await render(
      <div style={{ height: 400, width: 700, overflow: "hidden" }}>
        <div className="h-full min-h-0">
          <FilePreviewPanel
            cwd="/repo/long-file"
            relativePath="long-reveal.ts"
            revealLine={450}
            threadRef={threadRef}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      // Rows carry 1-based data-line attributes inside shadow DOM; pierce to
      // reach them alongside the editor caret.
      const pierce = (root: ParentNode, selector: string): Element | null => {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        for (const host of root.querySelectorAll("*")) {
          if (host.shadowRoot) {
            const found = pierce(host.shadowRoot, selector);
            if (found) return found;
          }
        }
        return null;
      };
      // The editor resolves the line through its own geometry and centers
      // it; assert on the shared scroll container, not library internals.
      await vi.waitFor(
        () => {
          const viewport = document.querySelector(".file-preview-virtualizer");
          expect(viewport).not.toBeNull();
          expect((viewport as HTMLElement).scrollTop).toBeGreaterThan(0);
        },
        { timeout: 15000 },
      );
      // Chat links are 1-based while editor lines are 0-based: the caret for
      // link line 450 must sit on row 450, detectably nearer to it than to
      // row 451, or every reveal lands one line too far.
      await vi.waitFor(
        () => {
          const caret = pierce(document, "[data-caret]");
          const row450 = pierce(document, '[data-line="450"]');
          const row451 = pierce(document, '[data-line="451"]');
          expect(caret).not.toBeNull();
          expect(row450).not.toBeNull();
          expect(row451).not.toBeNull();
          const caretTop = caret!.getBoundingClientRect().top;
          const near450 = Math.abs(caretTop - row450!.getBoundingClientRect().top);
          const near451 = Math.abs(caretTop - row451!.getBoundingClientRect().top);
          expect(near450).toBeLessThan(near451);
        },
        { timeout: 15000 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("sizes preview code from the Fonts code-size setting", async () => {
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/font-check"
        relativePath="src/index.ts"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("export const covered = true;")).toBeInTheDocument();
      // Pierre renders code inside shadow DOM, so pierce shadow roots to
      // reach the element the --diffs-font-size variable resolves on.
      const collect = (root: ParentNode, selector: string, out: Element[]): void => {
        for (const el of root.querySelectorAll(selector)) out.push(el);
        for (const host of root.querySelectorAll("*")) {
          if (host.shadowRoot) collect(host.shadowRoot, selector, out);
        }
      };
      const pres: Element[] = [];
      const host = document.querySelector(".file-preview-virtualizer");
      expect(host).not.toBeNull();
      collect(host!, "pre", pres);
      expect(pres.length).toBeGreaterThan(0);
      // Settings default codeFontSize is 13px; the Pierre default is 13px.
      for (const pre of pres) {
        expect(getComputedStyle(pre).fontSize).toBe("13px");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("wraps long lines by default like upstream", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "wrap.ts",
      contents: `export const wrapped = "${"x".repeat(400)}";`,
    });
    const screen = await render(
      <div style={{ height: 400, width: 500, overflow: "hidden" }}>
        <div className="h-full min-h-0">
          <FilePreviewPanel
            cwd="/repo/wrap-default"
            relativePath="wrap.ts"
            threadRef={threadRef}
            onOpenFile={vi.fn()}
          />
        </div>
      </div>,
    );
    try {
      await vi.waitFor(() => {
        const viewport = document.querySelector(".file-preview-virtualizer");
        expect(viewport).not.toBeNull();
        // Wrapped text never overflows horizontally.
        expect(viewport!.scrollWidth).toBeLessThanOrEqual(viewport!.clientWidth + 1);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders the workspace tree", async () => {
    const screen = await render(
      <FilePreviewPanel
        cwd="/caller/cannot-control-this"
        relativePath={null}
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(listEntriesMock).toHaveBeenCalledWith({
          cwd: "/caller/cannot-control-this",
        });
        expect(document.querySelector("[data-file-browser-panel]")).not.toBeNull();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders file markdown like upstream: constrained container, file-dir links, persistent tasks", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "docs/notes.md",
      contents: "# Notes\n\n- [ ] Ship it\n\nSee [guide](guide.md).\n",
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/markdown-upstream"
        relativePath="docs/notes.md"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(
        () => {
          expect(page.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
        },
        { timeout: 10000 },
      );
      // Upstream centers file markdown in a constrained, padded container.
      expect(document.querySelector(".chat-markdown.mx-auto.max-w-4xl")).not.toBeNull();
      // Relative links anchor at the file's own directory, not the workspace root.
      const guideLink = document.querySelector(
        '.chat-markdown a[href="/repo/markdown-upstream/docs/guide.md"]',
      );
      expect(guideLink).not.toBeNull();

      // Task checkboxes persist through the file save session.
      const checkbox = page.getByRole("checkbox", { name: "Toggle task" });
      await expect.element(checkbox).toBeInTheDocument();
      await checkbox.click();
      await vi.waitFor(
        () => {
          expect(writeFileMock).toHaveBeenCalledWith({
            cwd: "/repo/markdown-upstream",
            relativePath: "docs/notes.md",
            contents: "# Notes\n\n- [x] Ship it\n\nSee [guide](guide.md).\n",
          });
        },
        { timeout: 10000 },
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renders text files and promotes HTML/PDF files into the browser", async () => {
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/project"
        relativePath="src/index.ts"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("export const covered = true;")).toBeInTheDocument();
      expect(readFileMock).toHaveBeenCalledWith({
        cwd: "/repo/project",
        relativePath: "src/index.ts",
      });

      await screen.rerender(
        <FilePreviewPanel
          cwd="/repo/project"
          relativePath="reports/result.pdf"
          threadRef={threadRef}
          onOpenFile={vi.fn()}
        />,
      );
      await page.getByRole("button", { name: "Open in browser" }).click();
      expect(openFileInPreviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadRef,
          relativePath: "reports/result.pdf",
          httpBaseUrl: "http://localhost:3773",
          createAssetUrl: createAssetUrlMock,
          openPreview: openPreviewMock,
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renders binary images as image previews", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "assets/logo.png",
      contents: "",
      binary: true,
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/binary-preview"
        relativePath="assets/logo.png"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByRole("img", { name: "assets/logo.png" })).toBeInTheDocument();
      expect(createAssetUrlMock).toHaveBeenCalledWith({
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "assets/logo.png",
        },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders unsupported binary files as read-only notices", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "assets/archive.bin",
      contents: "",
      binary: true,
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/binary-preview"
        relativePath="assets/archive.bin"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect
        .element(page.getByText("This binary file cannot be previewed or edited as text."))
        .toBeInTheDocument();
      expect(page.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("toggles markdown files between rendered preview and source", async () => {
    readFileMock.mockResolvedValueOnce({
      relativePath: "notes.md",
      contents: "# Notes\n\nHello **world**.",
    });
    const screen = await render(
      <FilePreviewPanel
        cwd="/repo/markdown"
        relativePath="notes.md"
        threadRef={threadRef}
        onOpenFile={vi.fn()}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Preview", exact: true }))
        .toBeInTheDocument();
      await vi.waitFor(
        () => {
          expect(page.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
        },
        { timeout: 10000 },
      );

      await page.getByRole("button", { name: "Source", exact: true }).click();
      await expect.element(page.getByText("Hello **world**.")).toBeInTheDocument();

      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await vi.waitFor(
        () => {
          expect(page.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
        },
        { timeout: 10000 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
