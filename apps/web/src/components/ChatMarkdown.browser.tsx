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
import { serializeTableElementToCsv, serializeTableElementToMarkdown } from "../markdown-clipboard";
import {
  __readWorkspaceFilePanelStateForTests,
  __resetWorkspaceFilePanelStateForTests,
} from "../workspaceFilePreview";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    resolveEnvironmentHttpUrlMock.mockClear();
    __resetWorkspaceFilePanelStateForTests();
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

  it("opens workspace file links in the file preview panel", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[ChatMarkdown.tsx](apps/web/src/components/ChatMarkdown.tsx)"
        cwd="/repo/project"
        environmentId={EnvironmentId.make("environment-chat-markdown-preview")}
      />,
    );

    try {
      await page.getByRole("link", { name: "ChatMarkdown.tsx" }).click();

      await vi.waitFor(() => {
        expect(__readWorkspaceFilePanelStateForTests()).toMatchObject({
          open: true,
          view: "preview",
          target: {
            cwd: "/repo/project",
            relativePath: "apps/web/src/components/ChatMarkdown.tsx",
          },
        });
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
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
      const favicon = link.element().querySelector<HTMLElement>(".chat-markdown-link-favicon");
      const leading = link.element().querySelector<HTMLElement>(".chat-markdown-link-leading");
      expect(favicon).not.toBeNull();
      expect(leading).not.toBeNull();
      expect(leading?.contains(favicon)).toBe(true);
      expect(getComputedStyle(leading!).display).toBe("inline");
      expect(getComputedStyle(leading!).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(favicon!).verticalAlign).not.toBe("baseline");
      expect(leading?.textContent).toBe("O");
      expect(link.element().textContent).toBe("OpenAI");
      expect(getComputedStyle(link.element()).textDecorationLine).toBe("none");
      expect(link.element().querySelector("img, svg")?.getBoundingClientRect().width).toBe(14);
      await link.hover();
      expect(getComputedStyle(link.element()).backgroundImage).not.toBe("none");
      await expect.element(page.getByText("https://openai.com/docs")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders fenced code text inside markdown list items", async () => {
    const text = [
      "1. Update `apps/web/src/components/ChatView.tsx`.",
      "",
      "   Add a helper:",
      "",
      "   ```ts",
      "   const openDiffPanelExclusive = useCallback(() => {",
      "     closeWorkspaceFilePreview();",
      "   }, [onDiffPanelOpen]);",
      "   ```",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={text} cwd="/repo/project" />);

    try {
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector('[data-code-highlight-state="highlighted"]'),
        ).not.toBeNull();
      });
      expect(screen.container.querySelector(".chat-markdown-codeblock")?.textContent).toContain(
        "const openDiffPanelExclusive",
      );
      await expect.element(page.getByText(/const openDiffPanelExclusive/)).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a favicon with the leading segment of a wrapping URL", async () => {
    const url = "https://github.com/pingdotgg/t3code/pull/3017/changes";
    const screen = await render(
      <div style={{ width: 180 }}>
        <ChatMarkdown text={`[${url}](${url})`} cwd="/repo/project" />
      </div>,
    );

    try {
      const link = page.getByRole("link", { name: url });
      const leading = link.element().querySelector<HTMLElement>(".chat-markdown-link-leading");
      const favicon = link.element().querySelector<HTMLElement>(".chat-markdown-link-favicon");
      expect(leading).not.toBeNull();
      expect(favicon).not.toBeNull();
      expect(leading?.contains(favicon)).toBe(true);
      expect(leading?.textContent).toBe("https://");
      expect(getComputedStyle(leading!).display).toBe("inline");
      expect(getComputedStyle(leading!).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(favicon!).verticalAlign).not.toBe("baseline");
      expect(link.element().textContent).toBe(url);
      expect(link.element().querySelectorAll("wbr").length).toBeGreaterThan(0);
      const markdownRoot = link.element().closest<HTMLElement>(".chat-markdown");
      expect(markdownRoot).not.toBeNull();
      expect(markdownRoot!.scrollWidth).toBeLessThanOrEqual(markdownRoot!.clientWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("renders file links with the shared file tag chip treatment", async () => {
    const screen = await render(
      <ChatMarkdown text="[package.json](path/to/package.json)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "package.json" });
      await expect.element(link).toHaveClass(/chat-markdown-file-link/);
      const element = document.querySelector<HTMLElement>(".chat-markdown-file-link");
      expect(element?.querySelector("img, svg")).not.toBeNull();
      expect(getComputedStyle(element!).display).toBe("inline-flex");
      expect(getComputedStyle(element!).textDecorationLine).toBe("none");
      expect(getComputedStyle(element!).borderStyle).toBe("solid");
      expect(getComputedStyle(element!).userSelect).not.toBe("none");
    } finally {
      await screen.unmount();
    }
  });

  it("renders sanitized details with the design-system collapsible", async () => {
    const source = [
      "<details open>",
      "<summary>Expandable details section</summary>",
      "",
      "This content includes **formatted text**.",
      "",
      '<span title="native tooltip should be stripped">Safe inline HTML</span>',
      "<script>window.__unsafeMarkdownScript = true</script>",
      "</details>",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

    try {
      const details = document.querySelector<HTMLElement>("[data-markdown-details]");
      const trigger = page.getByRole("button", { name: "Expandable details section" });
      expect(details).not.toBeNull();
      expect(details?.tagName).toBe("DIV");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(details?.querySelector("strong")?.textContent).toBe("formatted text");
      expect(details?.querySelector("script")).toBeNull();
      expect(details?.querySelector("[title]")).toBeNull();

      await trigger.click();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("renders footnotes as same-document references", async () => {
    const source = [
      "A claim with supporting context.[^context]",
      "",
      "[^context]: Supporting **footnote text**.",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

    try {
      const reference = document.querySelector<HTMLAnchorElement>(
        '.chat-markdown a[data-footnote-ref=""]',
      );
      const footnotes = document.querySelector<HTMLElement>(
        ".chat-markdown section[data-footnotes]",
      );
      expect(reference).not.toBeNull();
      expect(reference?.getAttribute("href")).toMatch(/^#user-content-fn-/);
      expect(reference?.hasAttribute("target")).toBe(false);
      expect(footnotes).not.toBeNull();
      expect(footnotes?.querySelector("strong")?.textContent).toBe("footnote text");
      expect(footnotes?.querySelector<HTMLAnchorElement>("a[data-footnote-backref]")?.target).toBe(
        "",
      );
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

  it("preserves a code block's horizontal scroll when markdown props change", async () => {
    // Wide single line so the <pre> overflows its constrained container and is scrollable.
    const longLine = `const data = "${"x".repeat(400)}";`;
    const text = `\`\`\`ts\n${longLine}\n\`\`\``;
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

      const preAfter = screen.container.querySelector<HTMLPreElement>(".chat-markdown-shiki pre");
      expect(preAfter).not.toBeNull();
      await vi.waitFor(() => {
        expect(
          screen.container.querySelector<HTMLPreElement>(".chat-markdown-shiki pre")?.scrollLeft,
        ).toBe(scrolledLeft);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("navigates hash links within the clicked markdown message", async () => {
    const source = [
      "A claim with supporting context.[^context]",
      "",
      "[^context]: Supporting footnote text.",
    ].join("\n");
    const originalUrl = window.location.href;
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const screen = await render(
      <div>
        <ChatMarkdown text={source} cwd="/repo/project" />
        <ChatMarkdown text={source} cwd="/repo/project" />
      </div>,
    );

    try {
      const markdownRoots = document.querySelectorAll<HTMLElement>(".chat-markdown");
      const secondRoot = markdownRoots[1];
      const secondReference =
        secondRoot?.querySelector<HTMLAnchorElement>('a[data-footnote-ref=""]');
      const secondFootnote = secondRoot?.querySelector<HTMLElement>(
        "section[data-footnotes] li[id]",
      );
      expect(secondReference).not.toBeNull();
      expect(secondFootnote).not.toBeNull();

      secondReference?.click();

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.instances[0]).toBe(secondFootnote);
      expect(window.location.hash).toBe(secondReference?.hash);

      const secondBackref = secondRoot?.querySelector<HTMLAnchorElement>(
        "a[data-footnote-backref]",
      );
      expect(secondBackref).not.toBeNull();
      secondBackref?.click();

      const secondReferenceTarget = secondReference?.closest<HTMLElement>("[id]");
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.mock.instances[1]).toBe(secondReferenceTarget);
    } finally {
      scrollIntoView.mockRestore();
      window.history.replaceState(window.history.state, "", originalUrl);
      await screen.unmount();
    }
  });

  describe("code block chrome", () => {
    it("shows icon-only language titles, text fallbacks, and filename overrides", async () => {
      const source = [
        "```ts",
        "const a = 1;",
        "```",
        "",
        '```ts title="src/main.ts"',
        "const b = 2;",
        "```",
        "",
        "```text",
        "plain",
        "```",
      ].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const titles = [...document.querySelectorAll(".chat-markdown-codeblock-title")];
        expect(titles).toHaveLength(3);

        // Language with a known icon: icon XOR text — never the redundant pair.
        const languageOnly = titles[0]!;
        const hasIcon = languageOnly.querySelector("svg[data-pierre-icon]") != null;
        const hasText = (languageOnly.textContent ?? "").includes("ts");
        expect(hasIcon || hasText).toBe(true);
        expect(hasIcon && hasText).toBe(false);
        if (hasIcon) {
          const languageTrigger = page.getByLabelText("Language: ts").first();
          await languageTrigger.hover();
          await vi.waitFor(() => {
            const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
            expect(tooltip?.textContent).toContain("ts");
          });
        }

        // Explicit filename: text always shown.
        expect(titles[1]!.textContent).toBe("src/main.ts");

        // Unknown language: no icon attempt, text label.
        expect(titles[2]!.querySelector("svg[data-pierre-icon]")).toBeNull();
        expect(titles[2]!.textContent).toBe("text");
      } finally {
        await screen.unmount();
      }
    });

    it("toggles line wrapping per block", async () => {
      const screen = await render(
        <ChatMarkdown text={'```ts\nconst x = "long";\n```'} cwd="/repo/project" />,
      );

      try {
        const block = document.querySelector(".chat-markdown-codeblock");
        expect(block?.getAttribute("data-wrap")).toBe("false");

        const toggle = page.getByRole("button", { name: "Wrap lines" });
        await expect.element(toggle).not.toHaveAttribute("title");
        await toggle.hover();
        await vi.waitFor(() => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip?.textContent).toContain("Wrap lines");
        });
        await toggle.click();
        expect(block?.getAttribute("data-wrap")).toBe("true");

        await page.getByRole("button", { name: "Disable line wrap" }).click();
        expect(block?.getAttribute("data-wrap")).toBe("false");
      } finally {
        await screen.unmount();
      }
    });
  });

  it("scrolls wide tables horizontally instead of letter-wrapping cells", async () => {
    const header = `| ${Array.from({ length: 8 }, (_, i) => `ColumnHeading${i}`).join(" | ")} |`;
    const separator = `| ${Array.from({ length: 8 }, () => "---").join(" | ")} |`;
    const row = `| ${Array.from({ length: 8 }, () => "averylongunbrokencellvalue@example-domain.com").join(" | ")} |`;
    const screen = await render(
      <ChatMarkdown text={[header, separator, row].join("\n")} cwd="/repo/project" />,
    );

    try {
      const viewport = document.querySelector(
        '.chat-markdown-table-container [data-slot="scroll-area-viewport"]',
      );
      expect(viewport).not.toBeNull();
      expect(viewport!.querySelector("table")).not.toBeNull();
      // Content exceeds the container — the scroll-fade viewport scrolls
      // horizontally rather than squishing columns.
      expect(viewport!.scrollWidth).toBeGreaterThan(viewport!.clientWidth);
      // And cells keep their longest word intact instead of breaking mid-word.
      const cell = viewport!.querySelector("td");
      expect(cell!.getBoundingClientRect().width).toBeGreaterThan(100);
    } finally {
      await screen.unmount();
    }
  });

  describe("table chrome", () => {
    const longCell =
      "This service has been experiencing intermittent latency spikes during peak traffic hours and the on-call team is investigating.";

    it("truncates cells by default and expands them from the footer toggle", async () => {
      const source = ["| Name | Notes |", "| --- | --- |", `| api | ${longCell} |`].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const container = document.querySelector(".chat-markdown-table-container");
        expect(container?.getAttribute("data-expanded")).toBe("false");

        const noteCell = [...document.querySelectorAll(".chat-markdown td")].at(-1)!;
        expect(getComputedStyle(noteCell).whiteSpace).toBe("nowrap");
        expect(noteCell.scrollWidth).toBeGreaterThan(noteCell.clientWidth);

        const expandButton = page.getByRole("button", { name: "Expand table cells" });
        await expect.element(expandButton).not.toHaveAttribute("title");
        await expandButton.hover();
        await vi.waitFor(() => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip?.textContent).toContain("Expand table cells");
        });
        await expandButton.click();
        expect(container?.getAttribute("data-expanded")).toBe("true");
        expect(getComputedStyle(noteCell).whiteSpace).not.toBe("nowrap");

        await page.getByRole("button", { name: "Collapse table cells" }).click();
        expect(container?.getAttribute("data-expanded")).toBe("false");

        const copyButton = page.getByRole("button", { name: "Copy table" });
        await expect.element(copyButton).not.toHaveAttribute("title");
        await copyButton.hover();
        await vi.waitFor(() => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip?.textContent).toContain("Copy table");
        });
        expect(document.querySelector(".chat-markdown [title]")).toBeNull();
      } finally {
        await screen.unmount();
      }
    });

    it("retains column widths when cells expand", async () => {
      const source = [
        "| ID | Owner | Status | Priority | Region | Summary | Long Description | Metrics | Payload | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        '| 1001 | Ada Lovelace | Active | High | us-west-2 | Payment workflow migration | This cell has enough text to wrap across several lines when expanded without shrinking its column. | Requests: 128,440; Error rate: 0.04%; P95: 212ms | `{ "feature": "billing", "version": 3 }` | Needs post-release monitoring for 24 hours. |',
      ].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const viewport = document.querySelector(
          '.chat-markdown-table-container [data-slot="scroll-area-viewport"]',
        )!;
        const table = viewport.querySelector("table")!;
        const collapsedWidths = [...table.querySelectorAll("thead th")].map(
          (cell) => cell.getBoundingClientRect().width,
        );
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);

        await page.getByRole("button", { name: "Expand table cells" }).click();

        const expandedWidths = [...table.querySelectorAll("thead th")].map(
          (cell) => cell.getBoundingClientRect().width,
        );
        expect(expandedWidths).toHaveLength(collapsedWidths.length);
        expandedWidths.forEach((width, index) => {
          expect(width).toBeGreaterThanOrEqual(collapsedWidths[index]! - 1);
        });
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      } finally {
        await screen.unmount();
      }
    });

    it("exports tables as markdown and csv", async () => {
      const source = [
        "| Name | Count |",
        "| --- | ---: |",
        '| widget, "deluxe" | 2 |',
        "| plain | 1 |",
      ].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const table = document.querySelector(".chat-markdown table")!;
        expect(serializeTableElementToMarkdown(table)).toBe(
          ["| Name | Count |", "| --- | ---: |", '| widget, "deluxe" | 2 |', "| plain | 1 |"].join(
            "\n",
          ),
        );
        expect(serializeTableElementToCsv(table)).toBe(
          ["Name,Count", '"widget, ""deluxe""",2', "plain,1"].join("\n"),
        );
      } finally {
        await screen.unmount();
      }
    });
  });

  describe("copying rendered markdown", () => {
    function copySelectedMarkdown(): { text: string; html: string } {
      const root = document.querySelector(".chat-markdown");
      if (!root) throw new Error("chat-markdown root not rendered");
      const selection = window.getSelection();
      if (!selection) throw new Error("selection unavailable");
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(root);
      selection.addRange(range);

      const clipboardData = new DataTransfer();
      root.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
      );
      selection.removeAllRanges();
      return {
        text: clipboardData.getData("text/plain"),
        html: clipboardData.getData("text/html"),
      };
    }

    it("round-trips links, emphasis, and inline code", async () => {
      const screen = await render(
        <ChatMarkdown
          text="Check out [Anthropic](https://anthropic.com), **bold**, *italic*, and `code`."
          cwd="/repo/project"
        />,
      );

      try {
        const { text, html } = copySelectedMarkdown();
        expect(text).toBe(
          "Check out [Anthropic](https://anthropic.com), **bold**, *italic*, and `code`.",
        );
        expect(html).toContain('href="https://anthropic.com"');
      } finally {
        await screen.unmount();
      }
    });

    it("round-trips block structure: headings, lists, quotes, and fences", async () => {
      const source = [
        "## Heading",
        "",
        "- first",
        "- second",
        "  - nested",
        "",
        "1. one",
        "2. two",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "> quoted",
        "",
        "```ts",
        "const x = 1;",
        "",
        "const y = 2;",
        "```",
      ].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const { text } = copySelectedMarkdown();
        expect(text).toBe(source);
      } finally {
        await screen.unmount();
      }
    });

    it("round-trips tables with alignment", async () => {
      const source = ["| Name | Count |", "| --- | ---: |", "| a | 1 |", "| b | 2 |"].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const { text } = copySelectedMarkdown();
        expect(text).toBe(source);
      } finally {
        await screen.unmount();
      }
    });

    it("round-trips details rendered through the collapsible", async () => {
      const source = [
        "<details open>",
        "<summary>Expandable details section</summary>",
        "",
        "This content includes **formatted text**.",
        "</details>",
      ].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const { text } = copySelectedMarkdown();
        expect(text).toBe(source);
      } finally {
        await screen.unmount();
      }
    });

    it("excludes the code block header chrome from copied markdown", async () => {
      const source = ["```ts", "const x = 1;", "```"].join("\n");
      const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

      try {
        const { text } = copySelectedMarkdown();
        expect(text).toBe(source);
      } finally {
        await screen.unmount();
      }
    });

    it("copies file links as markdown and skips UI affordances", async () => {
      const filePath = "/Users/yashsingh/p/t3code/src/utils/permissions/PermissionRule.ts";
      const screen = await render(
        <ChatMarkdown
          text={`See [PermissionRule.ts](file://${filePath}) for details.`}
          cwd="/repo/project"
        />,
      );

      try {
        const { text, html } = copySelectedMarkdown();
        expect(text).toBe(
          `See [PermissionRule.ts](/Users/yashsingh/p/t3code/src/utils/permissions/PermissionRule.ts) for details.`,
        );
        expect(html).toContain("PermissionRule.ts");
        expect(html).not.toContain("<img");
      } finally {
        await screen.unmount();
      }
    });

    it("copies skill and file chips with source encodings that recreate composer chips", async () => {
      const source =
        "Use $agent-browser with [package.json](path/to/package.json) before continuing.";
      const screen = await render(
        <ChatMarkdown
          text={source}
          cwd="/repo/project"
          skills={[{ name: "agent-browser", displayName: "Agent Browser" }]}
        />,
      );

      try {
        const root = document.querySelector(".chat-markdown")!;
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(root);
        selection.addRange(range);
        expect(selection.toString()).toContain("Agent Browser");
        expect(selection.toString()).toContain("package.json");
        selection.removeAllRanges();

        const { text, html } = copySelectedMarkdown();
        expect(text).toBe(source);
        expect(html).toContain("Agent Browser");
        expect(html).toContain("package.json");
        expect(html).not.toContain("<img");
      } finally {
        await screen.unmount();
      }
    });
  });
});
