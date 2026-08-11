import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { HexColorInlineText, parseHexColorLiteral } from "./HexColorInlineText";
import { renderSkillInlineMarkdownChildren, SkillInlineText } from "./SkillInlineText";

const SWATCH_MARKER = 'aria-hidden="true"';

function renderText(text: string): string {
  return renderToStaticMarkup(<HexColorInlineText text={text} />);
}

function countSwatches(html: string): number {
  return html.split("background-color:").length - 1;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p({ node: _node, children, ...props }) {
          return <p {...props}>{renderSkillInlineMarkdownChildren(children, [])}</p>;
        },
        li({ node: _node, children, ...props }) {
          return <li {...props}>{renderSkillInlineMarkdownChildren(children, [])}</li>;
        },
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("HexColorInlineText", () => {
  it("renders a swatch beside a hex literal without altering the text", () => {
    const html = renderText("Use #FF5733 for the accent");

    expect(html).toContain("background-color:#FF5733");
    expect(html).toContain(SWATCH_MARKER);
    expect(stripTags(html)).toBe("Use #FF5733 for the accent");
  });

  it("renders a swatch for lowercase and 8-digit alpha literals", () => {
    expect(renderText("border #00aabb")).toContain("background-color:#00aabb");
    expect(renderText("overlay #33221180")).toContain("background-color:#33221180");
  });

  it("renders one swatch per literal", () => {
    const html = renderText("From #FF5733 to #00aabb, then #ffffff.");

    expect(countSwatches(html)).toBe(3);
    expect(stripTags(html)).toBe("From #FF5733 to #00aabb, then #ffffff.");
  });

  it("matches literals wrapped in punctuation", () => {
    expect(countSwatches(renderText("use (#FF5733), or #336699."))).toBe(2);
  });

  it("keeps a literal and its swatch on the same line", () => {
    expect(renderText("#FF5733")).toContain('class="whitespace-nowrap"');
  });

  it("ignores shorthand lengths that read as issue references", () => {
    const html = renderText("See #123 and t3code #5815 and #12345 for details");

    expect(countSwatches(html)).toBe(0);
    expect(stripTags(html)).toBe("See #123 and t3code #5815 and #12345 for details");
  });

  it("ignores non-hex digits and overlong runs", () => {
    expect(renderText("#GGGHHH #1234567 #FF5733A #aabbccdd11")).not.toContain("background-color");
  });

  it("ignores hex runs embedded in longer tokens and HTML entities", () => {
    expect(renderText("page#aabbcc and ##aabbcc and &#123456;")).not.toContain("background-color");
  });

  it("leaves text without hex literals untouched", () => {
    expect(renderText("no colors here")).toBe("no colors here");
  });
});

describe("parseHexColorLiteral", () => {
  it("accepts a lone 6- or 8-digit literal, trimming whitespace", () => {
    expect(parseHexColorLiteral("#FF5733")).toBe("#FF5733");
    expect(parseHexColorLiteral(" #ff573380 ")).toBe("#ff573380");
  });

  it("rejects shorthand, invalid digits, and anything beyond a single literal", () => {
    expect(parseHexColorLiteral("#F53")).toBeNull();
    expect(parseHexColorLiteral("#5815")).toBeNull();
    expect(parseHexColorLiteral("#1234567")).toBeNull();
    expect(parseHexColorLiteral("#GGGHHH")).toBeNull();
    expect(parseHexColorLiteral("color: #FF5733")).toBeNull();
    expect(parseHexColorLiteral("")).toBeNull();
  });
});

describe("renderSkillInlineMarkdownChildren hex swatches", () => {
  it("decorates paragraph, list, and emphasized text", () => {
    const html = renderMarkdown("Accent is **#FF5733**.\n\n- border #00FF00");

    expect(html).toContain("background-color:#FF5733");
    expect(html).toContain("background-color:#00FF00");
  });

  it("leaves inline code and links to their own renderers", () => {
    const html = renderMarkdown("`#FF5733` and [#00FF00](https://example.com)");

    expect(html).not.toContain("background-color");
  });
});

describe("SkillInlineText hex swatches", () => {
  it("decorates the plain runs around skill chips", () => {
    const html = renderToStaticMarkup(
      <SkillInlineText
        text="run $review on #00aabb then #FF5733"
        skills={[{ name: "review", displayName: "Review" }]}
      />,
    );

    expect(countSwatches(html)).toBe(2);
    expect(html).toContain("background-color:#00aabb");
    expect(html).toContain("background-color:#FF5733");
    expect(html).toContain('data-markdown-copy="$review"');
  });
});
