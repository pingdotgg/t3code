import "../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { openInPreferredEditorMock, readLocalApiMock, resolveEnvironmentHttpUrlMock } = vi.hoisted(
  () => ({
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: { openInEditor: vi.fn(async () => undefined) },
    })),
    resolveEnvironmentHttpUrlMock: vi.fn(
      (input: { pathname: string; searchParams?: Record<string, string> }) => {
        const url = new URL(`http://environment.test${input.pathname}`);
        if (input.searchParams) {
          url.search = new URLSearchParams(input.searchParams).toString();
        }
        return url.toString();
      },
    ),
  }),
);

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

vi.mock("../environments/runtime", () => ({
  resolveEnvironmentHttpUrl: resolveEnvironmentHttpUrlMock,
}));

// Replace the real (WASM-backed) Shiki highlighter with a deterministic, synchronous fake
// so code-block tests are fast and reliable. A single resolved promise is returned for every
// call so `use()` resolves once and the highlighter reference stays stable across renders.
// Everything else in the module — including the real shared highlight LRU cache — is kept,
// so the cache populate/evict behavior under test is exercised for real.
vi.mock("../codeHighlighting", async (importActual) => {
  const actual = await importActual<typeof import("../codeHighlighting")>();
  const fakeHighlighter = {
    codeToHtml: (code: string) =>
      `<pre class="shiki test-shiki" style="overflow-x:auto;white-space:pre;margin:0"><code>${code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</code></pre>`,
  };
  const highlighterPromise = Promise.resolve(fakeHighlighter);
  return {
    ...actual,
    getCodeHighlighterPromise: () => highlighterPromise,
  };
});

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    resolveEnvironmentHttpUrlMock.mockClear();
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

  it("renders explicit workspace markdown images through the workspace image route", async () => {
    const onImageExpand = vi.fn();
    const screen = await render(
      <ChatMarkdown
        text="![Generated chart](outputs/chart.png)"
        cwd="/repo/project"
        environmentId={EnvironmentId.make("environment-local")}
        onImageExpand={onImageExpand}
      />,
    );

    try {
      const image = page.getByAltText("Generated chart");
      await expect.element(image).toBeVisible();
      await expect
        .element(image)
        .toHaveAttribute(
          "src",
          "http://environment.test/api/workspace-image?cwd=%2Frepo%2Fproject&relativePath=outputs%2Fchart.png",
        );

      await page.getByRole("button", { name: "Preview Generated chart" }).click();
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [
          {
            src: "http://environment.test/api/workspace-image?cwd=%2Frepo%2Fproject&relativePath=outputs%2Fchart.png",
            name: "Generated chart",
          },
        ],
        index: 0,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not auto-render non-image markdown file links as images", async () => {
    const screen = await render(
      <ChatMarkdown
        text="![Source file](src/index.ts)"
        cwd="/repo/project"
        environmentId={EnvironmentId.make("environment-local")}
      />,
    );

    try {
      await expect.element(page.getByAltText("Source file")).not.toBeInTheDocument();
      expect(resolveEnvironmentHttpUrlMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("restores a code block's horizontal scroll when the block is remounted", async () => {
    // Wide single line so the <pre> overflows its constrained container and is scrollable.
    const longLine = `const data = "${"x".repeat(400)}";`;
    const text = `\`\`\`ts\n${longLine}\n\`\`\``;
    // Changing `cwd` recreates ChatMarkdown's `components` map, giving the inline `pre`
    // renderer a new identity — react-markdown then remounts the whole code-block subtree,
    // rebuilding the <pre> from scratch (the same thing that drops scroll in production).
    const renderUi = (cwd: string) => (
      <div style={{ width: 220, overflow: "hidden" }}>
        <ChatMarkdown text={text} cwd={cwd} />
      </div>
    );
    const screen = await render(renderUi("/repo/project"));

    try {
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector('[data-code-highlight-state="highlighted"]'),
        ).not.toBeNull();
      });

      const preBefore = screen.container.querySelector<HTMLPreElement>(".chat-markdown-shiki pre");
      expect(preBefore).not.toBeNull();

      // Simulate the user scrolling the wide code block sideways. Programmatic scrollLeft
      // doesn't emit a scroll event, so dispatch one to drive the persistence listener.
      preBefore!.scrollLeft = 200;
      const scrolledLeft = preBefore!.scrollLeft;
      expect(scrolledLeft).toBeGreaterThan(0);
      preBefore!.dispatchEvent(new Event("scroll"));

      await screen.rerender(renderUi("/repo/other-project"));

      // The block was genuinely remounted (new <pre> node) ...
      const preAfter = screen.container.querySelector<HTMLPreElement>(".chat-markdown-shiki pre");
      expect(preAfter).not.toBeNull();
      expect(preAfter).not.toBe(preBefore);
      // ... but its horizontal scroll position is restored.
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector<HTMLPreElement>(".chat-markdown-shiki pre")?.scrollLeft,
        ).toBe(scrolledLeft);
      });
    } finally {
      await screen.unmount();
    }
  });
});
