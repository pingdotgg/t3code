import { describe, expect, it } from "@effect/vitest";

import { hasUnwritableWiki, markdownToWiki, wikiToMarkdown } from "./wikiMarkup.ts";

describe("wikiToMarkdown", () => {
  it("reads headings, emphasis, inline code and links", () => {
    expect(
      wikiToMarkdown(
        "h2. Plan\nSome *bold* and _italic_ text with {{code}} and [the docs|https://docs.example.com/a_b_c].\nsee [https://example.com/x]",
      ),
    ).toBe(
      "## Plan\nSome **bold** and *italic* text with `code` and [the docs](https://docs.example.com/a_b_c).\nsee <https://example.com/x>",
    );
  });

  it("reads nested bullet and numbered lists and block quotes", () => {
    expect(wikiToMarkdown("* one\n** two\n*# three\n# first\n## second\nbq. quoted *x*")).toBe(
      "- one\n   - two\n   1. three\n1. first\n   1. second\n> quoted **x**",
    );
  });

  it("keeps code blocks and snake_case untouched, with the language", () => {
    expect(
      wikiToMarkdown(
        "{code:java|title=A.java}\nint my_var = 1; // *not bold* h1. no\n{code}\nmy_var_name is fine\n{noformat}\n* raw\n{noformat}",
      ),
    ).toBe(
      "```java\nint my_var = 1; // *not bold* h1. no\n```\nmy_var_name is fine\n```\n* raw\n```",
    );
  });

  it("keeps a link whose label is code, and a literal NUL out of the tokens", () => {
    expect(wikiToMarkdown("See [{{IssueService.ts}}|https://example.com/a]")).toBe(
      "See [`IssueService.ts`](https://example.com/a)",
    );
    expect(wikiToMarkdown("{code}\u00000\u0000{code}")).toBe("```\n0\n```");
    // Backticks inside inline code need a longer delimiter, padded when they touch it.
    expect(wikiToMarkdown("{{a`b`c}} and {{`x}}")).toBe("``a`b`c`` and `` `x ``");
    expect(markdownToWiki("``a`b`c`` and `` `x ``")).toBe("{{a`b`c}} and {{`x}}");
    // Braces inside inline code stay inside it.
    expect(wikiToMarkdown("{{fn({a: 1}, *b*)}} and {{x = {a: 1}}}")).toBe(
      "`fn({a: 1}, *b*)` and `x = {a: 1}`",
    );
    expect(markdownToWiki(wikiToMarkdown("{{ x }}"))).toBe("{{ x }}");
  });

  it("puts a code macro written mid-line on lines of its own", () => {
    const markdown = wikiToMarkdown("See {code}x{code} here\n\nRest of body");
    expect(markdown).toBe("See \n```\nx\n```\n here\n\nRest of body");
    expect(markdownToWiki(markdown)).toBe("See \n{code}\nx\n{code}\n here\n\nRest of body");
  });

  it("reads code parameters by name, and closes a macro only with its own name", () => {
    expect(
      wikiToMarkdown(
        "{code:title=App.java|language=java}\nint a;\n{code}\n{noformat}\nUse {code}foo{code}\n{noformat}",
      ),
    ).toBe("```java\nint a;\n```\n```\nUse {code}foo{code}\n```");
    // A fence in the code needs a longer one around it.
    expect(wikiToMarkdown("{noformat}\n```\nx\n```\n{noformat}")).toBe("````\n```\nx\n```\n````");
    // Only a code block's own opener counts, not one quoted inside another block.
    expect(hasUnwritableWiki("{code:java|title=A.java}\nx\n{code}")).toBe(true);
    expect(hasUnwritableWiki("{code:java}\nx\n{code}\n{code:language=go}\ny\n{code}")).toBe(false);
    expect(hasUnwritableWiki("{noformat}\n{code:java|title=A.java}\n{noformat}")).toBe(false);
  });

  it("leaves macros it does not know as they are", () => {
    expect(wikiToMarkdown("{panel:title=Note}\nbody *bold*\n{panel}\n{color:red}x{color}")).toBe(
      "{panel:title=Note}\nbody **bold**\n{panel}\n{color:red}x{color}",
    );
  });
});

describe("markdownToWiki", () => {
  it("writes headings, emphasis, inline code and links", () => {
    expect(
      markdownToWiki(
        "## Plan\nSome **bold** and *italic* and __also bold__ but not foo__bar__baz with `code` and [the docs](https://docs.example.com/a_b_c).\n<https://example.com/x>",
      ),
    ).toBe(
      "h2. Plan\nSome *bold* and _italic_ and *also bold* but not foo__bar__baz with {{code}} and [the docs|https://docs.example.com/a_b_c].\n[https://example.com/x]",
    );
  });

  it("writes nested lists by indentation and block quotes", () => {
    expect(markdownToWiki("- one\n  - two\n    1. three\n1. first\n   - second\n> quoted")).toBe(
      "* one\n** two\n**# three\n# first\n#* second\nbq. quoted",
    );
  });

  it("writes fenced blocks as code macros and leaves their contents alone", () => {
    expect(markdownToWiki("```ts\nconst a = **b**; # not a heading\n```\n\n```\nplain\n```")).toBe(
      "{code:ts}\nconst a = **b**; # not a heading\n{code}\n\n{code}\nplain\n{code}",
    );
    // A fence closes only with its own character, at least as long as it opened.
    expect(markdownToWiki("~~~\n**x**\n```\n~~~")).toBe("{code}\n**x**\n```\n{code}");
    expect(markdownToWiki("````md\n```\ninner\n```\n````")).toBe(
      "{code:md}\n```\ninner\n```\n{code}",
    );
    // Only `{noformat}` can show a `{code}` line without closing on it.
    expect(markdownToWiki("```\n{code}\nhi\n{code}\n```")).toBe(
      "{noformat}\n{code}\nhi\n{code}\n{noformat}",
    );
    const quoted = "{noformat}\nUse {code}foo{code}\n{noformat}";
    expect(markdownToWiki(wikiToMarkdown(quoted))).toBe(quoted);
  });

  it("keeps a link whose label is code", () => {
    expect(markdownToWiki("See [`IssueService.ts`](https://example.com/a)")).toBe(
      "See [{{IssueService.ts}}|https://example.com/a]",
    );
    expect(markdownToWiki("[docs](https://example.org/a_(b))")).toBe(
      "[docs|https://example.org/a_(b)]",
    );
  });

  it("writes a fence indented under a list item without touching its contents", () => {
    expect(
      markdownToWiki("- Step 1\n  ```sh\n  # comment *glob*\n    indented\n  ```\n- Step 2"),
    ).toBe("* Step 1\n{code:sh}\n# comment *glob*\n  indented\n{code}\n* Step 2");
  });

  it("keeps Jira macros verbatim", () => {
    expect(markdownToWiki("{panel:title=Note}\nbody **bold**\n{panel}")).toBe(
      "{panel:title=Note}\nbody *bold*\n{panel}",
    );
  });

  it("writes bold italics with both markers nested", () => {
    expect(markdownToWiki("***bold italic***")).toBe("*_bold italic_*");
    expect(wikiToMarkdown("*_bold italic_*")).toBe("***bold italic***");
  });

  it("round-trips what a person writes", () => {
    const markdown =
      "# Title\n\nA **bold** move with `code`.\n\n- one\n  - two\n1. step\n\n```js\nlet a_b = 1;\n```";
    expect(wikiToMarkdown(markdownToWiki(markdown))).toBe(
      "# Title\n\nA **bold** move with `code`.\n\n- one\n   - two\n1. step\n\n```js\nlet a_b = 1;\n```",
    );
  });
});
