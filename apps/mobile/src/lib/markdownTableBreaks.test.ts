import { describe, expect, it } from "vite-plus/test";
import { markdownWithTableBreaks, splitMarkdownTables } from "./markdownDocument";

const table = "| Company | Fit |\n|---|---|\n| Acme | A |";

it("keeps cell inline markup, empty columns, and cross-block link definitions", () => {
  const markdown = [
    "Before [link][reference].",
    "",
    "| Name | Fit |",
    "| --- | ---: |",
    "| **Acme** \\| [link][reference] | |",
    "| # These are cell contents |",
    "",
    "After.",
    "",
    "[reference]: https://example.com",
  ].join("\n");
  const result = splitMarkdownTables(markdown);
  expect(result?.links).toEqual(["https://example.com"]);
  expect(result?.blocks.map((block) => block.kind)).toEqual(["markdown", "table", "markdown"]);
  expect(result?.blocks[1]).toMatchObject({
    kind: "table",
    align: [null, "right"],
    rows: [
      { cells: [{ text: "Name" }, { text: "Fit" }] },
      {
        cells: [
          {
            text: "Acme | link",
            markdown: "[reference]: https://example.com\n\n**Acme** \\| [link][reference]",
          },
          { markdown: "", text: "" },
        ],
      },
      { cells: [{ markdown: "&#35; These are cell contents", text: "# These are cell contents" }] },
    ],
  });
  expect(splitMarkdownTables(table)?.blocks[0]?.kind).toBe("table");
  expect(splitMarkdownTables(`\`\`\`md\n${table}\n\`\`\``)).toBeUndefined();
});

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
