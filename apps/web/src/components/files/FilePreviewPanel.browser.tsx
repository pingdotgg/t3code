import "../../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  openFileInPreviewMock,
  openPreviewMock,
  readFileMock,
  searchEntriesMock,
  createAssetUrlMock,
} = vi.hoisted(() => ({
  openFileInPreviewMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openPreviewMock: vi.fn(),
  readFileMock: vi.fn(async () => ({
    relativePath: "src/index.ts",
    contents: "export const covered = true;",
  })),
  searchEntriesMock: vi.fn(async () => ({
    entries: [
      { path: "src/index.ts", kind: "file" as const, parentPath: "src" },
      { path: "src", kind: "directory" as const },
    ],
    truncated: false,
  })),
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({
    projects: { searchEntries: searchEntriesMock, readFile: readFileMock },
    assets: { createUrl: createAssetUrlMock },
  })),
}));

vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://localhost:3773"),
}));

vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
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

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-files"),
  ThreadId.make("thread-files"),
);

describe("FilePreviewPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("searches the thread-authorized workspace and opens selected files", async () => {
    const onOpenFile = vi.fn();
    const screen = await render(
      <FilePreviewPanel
        cwd="/caller/cannot-control-this"
        relativePath={null}
        threadRef={threadRef}
        onOpenFile={onOpenFile}
      />,
    );
    try {
      await page.getByLabelText("Search workspace files").fill("index");
      await vi.waitFor(() => {
        expect(searchEntriesMock).toHaveBeenCalledWith({
          scope: { _tag: "thread", threadId: threadRef.threadId },
          query: "index",
          limit: 100,
        });
      });
      await page.getByRole("button", { name: "src/index.ts" }).click();
      expect(onOpenFile).toHaveBeenCalledWith("src/index.ts");
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
        threadId: threadRef.threadId,
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
});
