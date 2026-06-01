import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { openInPreferredEditorMock, readLocalApiMock } = vi.hoisted(() => ({
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
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

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
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

  it("renders html preview fences as script-enabled sandboxed iframes", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          '```t3-html-preview title="Counter preview" height=180',
          '<div id="counter">0</div>',
          "<script>document.getElementById('counter').textContent = '1';</script>",
          "```",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Hide preview" })).toBeInTheDocument();
      const frame = document.querySelector<HTMLIFrameElement>(
        'iframe[title="Counter preview preview"]',
      );
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame?.getAttribute("srcdoc")).toContain("script-src 'unsafe-inline'");
      expect(frame?.getAttribute("srcdoc")).toContain("connect-src 'none'");
      expect(frame?.getAttribute("srcdoc")).toContain("<script>");
    } finally {
      await screen.unmount();
    }
  });

  it("supports collapsed html previews that can be shown later", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          '```html-preview title="Hidden preview" collapsed',
          "<main>Hidden until opened</main>",
          "```",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await expect.element(page.getByText("Preview hidden")).toBeInTheDocument();
      expect(document.querySelector("iframe")).toBeNull();

      await page.getByRole("button", { name: "Show preview" }).click();

      await expect.element(page.getByRole("button", { name: "Hide preview" })).toBeInTheDocument();
      expect(document.querySelector('iframe[title="Hidden preview preview"]')).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("can maximize html previews into a dialog", async () => {
    const screen = await render(
      <ChatMarkdown
        text={['```preview-html title="Dialog preview"', "<section>Expanded</section>", "```"].join(
          "\n",
        )}
        cwd="/repo/project"
      />,
    );

    try {
      await page.getByRole("button", { name: "Maximize preview" }).click();

      await expect.element(page.getByRole("dialog")).toBeInTheDocument();
      await expect
        .element(page.getByRole("heading", { name: "Dialog preview" }))
        .toBeInTheDocument();
      expect(
        document.querySelector('iframe[title="Dialog preview maximized preview"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
