import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { FileSearchResults } from "./FileSearchResults";

function marks(container: Element) {
  return Array.from(container.querySelectorAll("mark"), (mark) => mark.textContent);
}

describe("FileSearchResults", () => {
  it("groups matches by file and highlights the pattern", async () => {
    await using screen = await render(
      <FileSearchResults
        pattern="export const \w+"
        workspaceRoot={undefined}
        results={[
          { fileName: "src/one.ts", line: 1, preview: 'export const heading = "intro";' },
          { fileName: "src/two.ts", line: 4, preview: "export const second = 2;" },
          { fileName: "src/one.ts", line: 3, preview: '    export const footer = "outro";' },
        ]}
      />,
      { router: false },
    );
    const sections = Array.from(screen.container.querySelectorAll("section"));
    expect(sections.map((section) => section.textContent)).toEqual([
      'src/one.ts2 matches1export const heading = "intro";3export const footer = "outro";',
      "src/two.ts4export const second = 2;",
    ]);
    expect(marks(screen.container)).toEqual([
      "export const heading",
      "export const footer",
      "export const second",
    ]);
  });

  it("falls back to a case-insensitive highlight and skips patterns JavaScript can't run safely", async () => {
    await using screen = await render(
      <div>
        <FileSearchResults
          pattern="needle"
          workspaceRoot={undefined}
          results={[{ fileName: "a.ts", line: 1, preview: "const NEEDLE = 1;" }]}
        />
        <FileSearchResults
          pattern="(?i)needle"
          workspaceRoot={undefined}
          results={[{ fileName: "b.ts", line: 2, preview: "const needle = 2;" }]}
        />
        <FileSearchResults
          pattern="(a+)+$|needle"
          workspaceRoot={undefined}
          results={[{ fileName: "c.ts", line: 3, preview: `${"a".repeat(100)}!needle` }]}
        />
        <FileSearchResults
          pattern="a+a+a+a+a+a+$|needle"
          workspaceRoot={undefined}
          results={[{ fileName: "d.ts", line: 4, preview: `${"a".repeat(1000)}!needle` }]}
        />
        <FileSearchResults
          pattern={`^${"(a|aa)".repeat(40)}b$|needle`}
          workspaceRoot={undefined}
          results={[{ fileName: "e.ts", line: 5, preview: `${"a".repeat(60)}!needle` }]}
        />
      </div>,
      { router: false },
    );
    expect(marks(screen.container)).toEqual(["NEEDLE"]);
    expect(screen.container.textContent).toContain("const needle = 2;");
    expect(screen.container.textContent).toContain(`${"a".repeat(100)}!needle`);
  });
});
