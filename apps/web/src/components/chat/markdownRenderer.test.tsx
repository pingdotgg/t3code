import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "./markdownRenderer";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;

describe("createMarkdownRenderer", () => {
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
    components: {},
    urlTransform,
  });

  it.each([
    '# Title\n\nText with `code`, **bold**, [a link](https://example.com "t") and https://bare.example.com.',
    "![shot](./shot.png) and [file](file:///C:/repo/a.ts) and [bad](javascript:alert(1))",
    "<details><summary>More</summary>\n\nHidden <b>bold</b> <script>x()</script>\n\n</details>",
    "| a | b |\n| - | - |\n| <br> | [x](#frag) |\n\n- [ ] task\n- [x] done",
    '```ts title="a.ts"\nconst a = 1;\n```\n\n> [!WARNING]\n> careful <a>bare</a>',
    "Footnote[^1] and ~~strike~~\n\n[^1]: the note",
  ])("renders what react-markdown renders: %j", (source) => {
    const expected = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>,
    );
    const element = render(source, true);
    expect(renderToStaticMarkup(element)).toBe(expected);
    expect(render(source, true)).toBe(element);
  });

  it("keeps cached messages when one far larger than the cache is rendered", () => {
    const element = render("Kept *message*", true);
    render("x".repeat(600_000), true);
    expect(render("Kept *message*", true)).toBe(element);
  });
});
