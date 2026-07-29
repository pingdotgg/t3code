import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const {
  createAssetUrlMock,
  openFileInPreviewMock,
  openInPreferredEditorMock,
  openPreviewMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  createAssetUrlMock: vi.fn(async () => ({ relativeUrl: "/assets/signed" })),
  openFileInPreviewMock: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  openPreviewMock: vi.fn(),
  readLocalApiMock: vi.fn(() => ({
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: { openInEditor: vi.fn(async () => undefined) },
  })),
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
}));

vi.mock("../previewStateStore", () => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => openPreviewMock),
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("../browser/openFileInPreview", () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
  openFileInPreview: openFileInPreviewMock,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-markdown"),
  ThreadId.make("thread-markdown"),
);

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    openFileInPreviewMock.mockClear();
    openPreviewMock.mockClear();
    createAssetUrlMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
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

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
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
