import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { markdownTree } from "../../markdown/wordsHast";
import { isClosedCodeFence } from "./MarkdownCodeBlock.logic";
import { createMarkdownRenderer } from "./markdownRenderer";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;

describe("createMarkdownRenderer", () => {
  const renderer = createMarkdownRenderer({
    markdown: { math: false, breaks: false, escapeHtml: false, insights: false, extensions: {} },
    components: {},
    urlTransform,
  });
  const render = (text: string) => renderer.element(renderer.parse(text));
  const renderAndRemember = (text: string) => {
    const entry = renderer.parse(text);
    renderer.remember(text, entry);
    return renderer.element(entry);
  };

  it("passes every URL attribute through the transform", () => {
    const html = renderToStaticMarkup(
      render('![shot](./shot.png) and [a link](https://example.com "t") and <img src="b.png">'),
    );
    expect(html).toContain('src="./shot.png#seen"');
    expect(html).toContain('href="https://example.com#seen"');
    expect(html).toContain('src="b.png#seen"');
  });

  it("reuses a remembered message's element", () => {
    const element = renderAndRemember("# Title\n\nText with `code` and **bold**.");
    expect(render("# Title\n\nText with `code` and **bold**.")).toBe(element);
  });

  it("keeps cached messages when one far larger than the cache is rendered", () => {
    const element = renderAndRemember("Kept *message*");
    renderAndRemember("x".repeat(600_000));
    expect(render("Kept *message*")).toBe(element);
  });
});

describe("isClosedCodeFence", () => {
  it.each([
    { name: "LF", separator: "\n" },
    { name: "CRLF", separator: "\r\n" },
    { name: "CR", separator: "\r" },
  ])("recognizes a closing fence with $name line endings", ({ separator }) => {
    const lines = ["```sh", "echo hi", "```"];
    for (const closed of [false, true]) {
      const source = (closed ? lines : lines.slice(0, -1)).join(separator);
      const [pre] = markdownTree(source).children;
      const code = pre?.type === "element" ? pre.children[0] : undefined;
      const content = code?.type === "element" ? code.children[0] : undefined;
      if (pre?.type !== "element" || content?.type !== "text") {
        throw new Error("Expected a parsed code block");
      }
      expect(content.value).toBe("echo hi\n");
      expect(isClosedCodeFence(pre, source, content.value)).toBe(closed);
    }
  });
});
