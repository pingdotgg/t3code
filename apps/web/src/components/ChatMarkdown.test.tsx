import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});

describe("chat markdown text direction", () => {
  function render(text: string) {
    return renderToStaticMarkup(<ChatMarkdown text={text} cwd="/repo" />);
  }

  it("lets each block pick its own direction from its own text", () => {
    const html = render("English first.\n\nمرحبا بالعالم.");
    expect(html).toContain('<p dir="auto">English first.</p>');
    expect(html).toContain('<p dir="auto">مرحبا بالعالم.</p>');
  });

  it("marks headings, lists, and quotes so their markers follow the text", () => {
    const html = render("# عنوان\n\n- عنصر\n\n> اقتباس");
    expect(html).toContain('<h1 dir="auto">');
    expect(html).toContain('<ul dir="auto">');
    expect(html).toContain('<blockquote dir="auto">');
  });

  it("marks only the outermost block, so a container still sees its own text", () => {
    // A nested `dir` would be skipped when the browser resolves the outer
    // `dir="auto"`, leaving the list LTR and its bullets in the wrong gutter.
    const html = render("- عنصر\n\n> اقتباس");
    expect(html).toContain("<li>");
    expect(html).not.toContain("<li dir=");
    expect(html).not.toContain('<blockquote dir="auto">\n<p dir="auto">');
  });

  it("pins code left-to-right so an Arabic comment cannot reorder a snippet", () => {
    const html = render("`git status` وأيضا\n\n```sh\n# تعليق\ngit status\n```");
    // The paragraph around it still reads right-to-left; only the code opts out.
    expect(html).toContain('<p dir="auto">');
    expect(html).toContain('<code data-inline-code="" dir="ltr">git status</code>');
    expect(html).toContain('<div dir="ltr" class="chat-markdown-codeblock');
  });

  it("gives a GitHub alert's body its own direction under LTR callout chrome", () => {
    // The alert renderer builds its own element, so the blockquote cannot be the
    // marked block — the body paragraphs have to carry the direction instead.
    const html = render("> [!NOTE]\n> مرحبا بالعالم.");
    expect(html).toContain('<p dir="auto">مرحبا بالعالم.</p>');
    expect(html).not.toContain("<blockquote");
  });

  it("pins a file-link chip left-to-right even inside right-to-left prose", () => {
    // The `code` renderer swaps the chip in for the `<code dir="ltr">` it
    // replaces, so a path in an Arabic sentence keeps its own reading order.
    const html = render("عدّل `src/main.ts` من فضلك.");
    expect(html).toContain('<a dir="ltr"');
  });

  it("keeps table columns in source order while cells read their own direction", () => {
    const html = render("| اسم | value |\n| --- | --- |\n| قيمة | 1 |");
    expect(html).toContain('<table dir="ltr">');
    expect(html).toContain('<th dir="auto">');
    expect(html).toContain('<td dir="auto">');
  });
});
