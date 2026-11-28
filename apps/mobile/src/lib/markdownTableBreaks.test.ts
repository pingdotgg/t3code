import { describe, expect, it } from "vite-plus/test";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import { markdownForNativeRendering, markdownWithTableBreaks } from "./markdownDocument";

const table = "| Company | Fit |\n|---|---|\n| Acme | A |";

describe("tables right under a line of text", () => {
  it("separates a table from the paragraph it interrupts", () => {
    expect(markdownWithTableBreaks(`Companies on file\n${table}`)).toBe(
      `Companies on file\n\n${table}`,
    );
  });

  it("handles CRLF and CR line endings", () => {
    const crlf = table.replaceAll("\n", "\r\n");
    expect(markdownWithTableBreaks(`Companies on file\r\n${crlf}`)).toBe(
      `Companies on file\r\n\r\n${crlf}`,
    );
    const cr = table.replaceAll("\n", "\r");
    expect(markdownWithTableBreaks(`Companies on file\r${cr}`)).toBe(`Companies on file\r\r${cr}`);
  });

  it("keeps the blank line inside a blockquote", () => {
    const quoted = table.replace(/^/gm, "> ");
    expect(markdownWithTableBreaks(`> Companies on file\n${quoted}`)).toBe(
      `> Companies on file\n>\n${quoted}`,
    );
  });

  it("keeps a table with a lazy header row inside its container", () => {
    expect(markdownWithTableBreaks("> Intro\n| a | b |\n> | - | - |\n> | c | d |")).toBe(
      "> Intro\n>\n> | a | b |\n> | - | - |\n> | c | d |",
    );
    expect(markdownWithTableBreaks("- Intro\n| a | b |\n  | - | - |\n  | c | d |")).toBe(
      "- Intro\n\n  | a | b |\n  | - | - |\n  | c | d |",
    );
  });

  it.each(["-", "1."])("normalizes tables under %s list items for native rendering", (marker) => {
    const indent = " ".repeat(marker.length + 1);
    const nestedTable = table.replace(/^/gm, indent);
    const expected = `${marker} Intro\n\n${nestedTable}`;

    for (const gap of ["\n", "\n\n"]) {
      expect(
        markdownForNativeRendering(
          `${marker} Intro${gap}${nestedTable}`,
          ENRICHED_INLINE_FILE_LINK_REGEX,
        ),
      ).toBe(expected);
    }
  });

  it("leaves Markdown that already renders alone", () => {
    for (const markdown of [
      `Companies on file\n\n${table}`,
      `# Companies\n${table}`,
      `\`\`\`md\nCompanies on file\n${table}\n\`\`\``,
      "Not a table\n| a | b |\n|---|",
      "a | b\nplain text",
    ]) {
      expect(markdownWithTableBreaks(markdown)).toBe(markdown);
    }
  });
});
